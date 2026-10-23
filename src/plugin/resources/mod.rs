pub(crate) mod files;
pub(crate) mod forward_process;
mod storage;
pub(crate) mod targets;
mod tunnel_profiles;

pub use storage::{AiSettingsAccess, NotificationAccess, StorageAccess, TunnelProfileAccess};

use self::targets::{authorize_lightos_session_target, authorize_session_target};
use crate::state::AppState;
use connectrpc::{ConnectError, ErrorCode as ConnectCode};
use neko_plugin::{
    BoxFuture, ErrorCode, InvokeReply, LightOsForward, PluginError, SessionContext, TargetContext,
    TargetRequest,
};
use std::sync::{Arc, Weak};

pub(crate) fn plugin_error(error: ConnectError) -> PluginError {
    let code = match error.code {
        ConnectCode::InvalidArgument => ErrorCode::InvalidArgument,
        ConnectCode::NotFound => ErrorCode::NotFound,
        ConnectCode::FailedPrecondition => ErrorCode::FailedPrecondition,
        ConnectCode::PermissionDenied => ErrorCode::PermissionDenied,
        ConnectCode::Unauthenticated => ErrorCode::Unauthenticated,
        ConnectCode::Unavailable => ErrorCode::Unavailable,
        ConnectCode::DeadlineExceeded => ErrorCode::DeadlineExceeded,
        ConnectCode::ResourceExhausted => ErrorCode::ResourceExhausted,
        ConnectCode::Unimplemented => ErrorCode::Unimplemented,
        _ => ErrorCode::Internal,
    };
    PluginError {
        code,
        message: error
            .message
            .unwrap_or_else(|| "plugin resource failed".into()),
    }
}

pub(crate) fn connect_error(error: PluginError) -> ConnectError {
    let code = match error.code {
        ErrorCode::InvalidArgument => ConnectCode::InvalidArgument,
        ErrorCode::NotFound => ConnectCode::NotFound,
        ErrorCode::FailedPrecondition => ConnectCode::FailedPrecondition,
        ErrorCode::PermissionDenied => ConnectCode::PermissionDenied,
        ErrorCode::Unauthenticated => ConnectCode::Unauthenticated,
        ErrorCode::Unavailable => ConnectCode::Unavailable,
        ErrorCode::DeadlineExceeded => ConnectCode::DeadlineExceeded,
        ErrorCode::ResourceExhausted => ConnectCode::ResourceExhausted,
        ErrorCode::Unimplemented => ConnectCode::Unimplemented,
        ErrorCode::Internal => ConnectCode::Internal,
    };
    ConnectError::new(code, error.message)
}

pub struct ContextAccess {
    pub state: Weak<AppState>,
}
impl TargetContext for ContextAccess {
    fn resolve<'a>(
        &'a self,
        target: &'a TargetRequest,
    ) -> BoxFuture<'a, Result<SessionContext, PluginError>> {
        Box::pin(async move {
            let state = self
                .state
                .upgrade()
                .ok_or_else(|| PluginError::unavailable("plugin host has stopped"))?;
            let session = targets::resolve(&state, &target.session_id, &target.metadata)
                .await
                .map_err(plugin_error)?;
            authorize_session_target(&state, &session, false)
                .await
                .map_err(plugin_error)?;
            Ok(SessionContext {
                id: session.id,
                selector: session.selector,
                status: session.status,
            })
        })
    }
}

pub struct ForwardAccess {
    pub state: Weak<AppState>,
    pub manager: Arc<forward_process::LightOsPortForwardManager>,
}
impl LightOsForward for ForwardAccess {
    fn invoke<'a>(
        &'a self,
        target: &'a TargetRequest,
        operation: &'a str,
    ) -> BoxFuture<'a, Result<InvokeReply, PluginError>> {
        Box::pin(async move {
            let state = self
                .state
                .upgrade()
                .ok_or_else(|| PluginError::unavailable("plugin host has stopped"))?;
            let session = targets::resolve(&state, &target.session_id, &target.metadata)
                .await
                .map_err(plugin_error)?;
            authorize_lightos_session_target(&session, true)
                .await
                .map_err(plugin_error)?;
            let manager = Arc::clone(&self.manager);
            let metadata = target.metadata.clone();
            let operation = operation.to_owned();
            let value = tokio::task::spawn_blocking(move || {
                manager.invoke(&session, &operation, &metadata)
            })
            .await
            .map_err(|err| PluginError::internal(err.to_string()))?
            .map_err(|err| PluginError::failed_precondition(err.to_string()))?;
            InvokeReply::json("complete", &value)
        })
    }
    fn stop_all(&self) -> Result<(), PluginError> {
        self.manager
            .stop_all()
            .map_err(|err| PluginError::internal(err.to_string()))
    }
}
