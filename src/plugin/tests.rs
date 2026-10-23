use std::collections::HashMap;
use std::sync::Arc;

use super::{
    PluginHost,
    resources::{AiSettingsAccess, NotificationAccess, StorageAccess},
    settings::{PluginStore, builtin_plugins},
};
use crate::database::{
    KV_KEY_PLUGINS, KV_KEY_SETTINGS, KV_NAMESPACE_PREFERENCES, KV_NAMESPACE_STATE,
};
use crate::state::AppState;
use connectrpc::ErrorCode;
use neko_plugin::{AiPreferences, NewNotification, PluginNotifications, PluginStorage};
use serde_json::json;

fn state() -> Arc<AppState> {
    let state = Arc::new(AppState::new_for_test(
        std::env::temp_dir().join(format!("neko-plugin-{}.db", uuid::Uuid::new_v4())),
    ));
    *state.plugin.settings.write().unwrap() = builtin_plugins();
    state
}

#[tokio::test]
async fn every_manifest_registers_and_unknown_file_operations_never_reach_a_target() {
    let state = state();
    let runtime = state.plugin.runtime(&state).await.unwrap();
    assert!(runtime.failures().is_empty());
    let request = neko_plugin::InvokeRequest {
        target: neko_plugin::TargetRequest::default(),
        operation: "delete".into(),
        content_type: "application/json".into(),
        payload: vec![],
    };
    let error = runtime.invoke("file-transfer", request).await.unwrap_err();
    assert_eq!(error.code, neko_plugin::ErrorCode::InvalidArgument);
    assert!(
        error
            .message
            .contains("unsupported file-transfer operation")
    );
    state.plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn plugin_configuration_survives_recreation_and_does_not_replace_terminal_authority() {
    let state = state();
    let sessions = Arc::clone(&state.sessions);
    let terminal_control = Arc::clone(&state.terminal_control);
    let descriptor = state
        .plugin
        .configure(
            &state,
            "white-noise",
            false,
            HashMap::from([
                ("floatingControls".into(), "false".into()),
                ("autoPlayOnSelect".into(), "false".into()),
                ("runtime".into(), "forged-runtime".into()),
                ("backends".into(), "ssh".into()),
            ]),
        )
        .await
        .unwrap();
    assert_eq!(descriptor.enabled, Some(false));
    assert_eq!(
        descriptor.metadata.get("runtime").map(String::as_str),
        Some("browser-audio")
    );
    assert!(!descriptor.metadata.contains_key("backends"));
    assert!(Arc::ptr_eq(&sessions, &state.sessions));
    assert!(Arc::ptr_eq(&terminal_control, &state.terminal_control));
    let recreated = PluginHost::new(state.database(), Arc::clone(&state.notifications));
    {
        let records = recreated.settings.read().unwrap();
        let noise = &records["white-noise"];
        assert!(!noise.enabled);
        assert_eq!(noise.metadata["floatingControls"], "false");
        assert_eq!(noise.metadata["autoPlayOnSelect"], "false");
        assert!(records["file-transfer"].enabled);
        assert!(!records["terminal-mcp"].enabled);
    }
    state.plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn invalid_configuration_leaves_saved_and_live_settings_unchanged() {
    let state = state();
    state
        .plugin
        .persist_settings(&state.plugin.settings.read().unwrap())
        .unwrap();
    let before = state
        .database()
        .load_kv(KV_NAMESPACE_STATE, KV_KEY_PLUGINS)
        .unwrap()
        .unwrap();
    let error = state
        .plugin
        .configure(
            &state,
            "terminal-mcp",
            true,
            HashMap::from([("defaultPolicy".into(), "unknown-policy".into())]),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArgument);
    assert_eq!(
        state
            .database()
            .load_kv(KV_NAMESPACE_STATE, KV_KEY_PLUGINS)
            .unwrap()
            .unwrap(),
        before
    );
    assert!(!state.plugin.settings.read().unwrap()["terminal-mcp"].enabled);
}

#[tokio::test]
async fn tunnel_profile_configuration_keeps_secrets_out_of_descriptors_and_metadata() {
    let state = state();
    let profiles = json!([{ "id": "test-profile", "provider": "ngrok", "name": "Test", "enabled": true, "authtoken": "private-profile-token" }]).to_string();
    let descriptor = state
        .plugin
        .configure(
            &state,
            "public-tunnel",
            false,
            HashMap::from([
                ("tunnelProviderProfiles".into(), profiles),
                ("ngrokAuthtoken".into(), "untrusted-inline-token".into()),
            ]),
        )
        .await
        .unwrap();
    let metadata = serde_json::to_string(&descriptor.metadata).unwrap();
    assert!(!metadata.contains("private-profile-token"));
    assert!(!metadata.contains("untrusted-inline-token"));
    assert!(metadata.contains("configured"));
    let saved = state.plugin.settings.read().unwrap()["public-tunnel"]
        .metadata
        .clone();
    assert!(!saved.contains_key("tunnelProviderProfiles"));
    assert!(!saved.contains_key("ngrokAuthtoken"));
    let stored = state
        .database()
        .load_tunnel_provider_profile("test-profile")
        .unwrap()
        .unwrap();
    assert!(stored.secret_json.contains("private-profile-token"));
    state.plugin.shutdown().await.unwrap();
}

#[test]
fn legacy_settings_and_timer_state_are_read_without_resetting_user_choices() {
    let state = state();
    let database = state.database();
    database
        .store_kv(
            KV_NAMESPACE_STATE,
            KV_KEY_PLUGINS,
            &serde_json::to_vec(&json!({ "version": 1, "plugins": [
        { "id": "ai-chat", "enabled": true, "metadata": { "operator": "saved" } },
        { "id": "terminal-transfer", "enabled": true, "metadata": { "protocols": "trzsz" } },
        { "id": "white-noise", "enabled": false, "metadata": { "autoPlayOnSelect": "false" } }
    ] }))
            .unwrap(),
        )
        .unwrap();
    let records = PluginStore::new(database.clone()).load().unwrap();
    assert!(records["ai-chat"].enabled);
    assert_eq!(records["ai-chat"].metadata["operator"], "saved");
    assert_eq!(records["terminal-transfer"].metadata["protocols"], "trzsz");
    assert!(!records["white-noise"].enabled);
    assert_eq!(records["ai-chat"].configuration_version, 1);
    database.store_kv(KV_NAMESPACE_STATE, "pomodoro", &serde_json::to_vec(&json!({ "status": "running", "durationMinutes": 17, "totalRounds": 3, "currentRound": 2, "startedAtMs": 1, "deadlineMs": 2 })).unwrap()).unwrap();
    let timer = state.plugin.pomodoro.state().unwrap();
    assert_eq!(timer.status, "completed");
    assert_eq!(timer.duration_minutes, 17);
    assert_eq!(timer.current_round, 2);
    let again = state.plugin.pomodoro.state().unwrap();
    assert_eq!(again.notification_id, timer.notification_id);
    assert_eq!(state.notifications.list_active().unwrap().len(), 1);
}

#[tokio::test]
async fn newer_configuration_is_preserved_and_cannot_be_overwritten() {
    let state = state();
    let database = state.database();
    database.store_kv(KV_NAMESPACE_STATE, KV_KEY_PLUGINS, &serde_json::to_vec(&json!({ "version": 1, "plugins": [
        { "id": "white-noise", "enabled": true, "configuration_version": 2, "metadata": { "futureSetting": "keep-me" } }
    ] })).unwrap()).unwrap();
    *state.plugin.settings.write().unwrap() = PluginStore::new(database.clone()).load().unwrap();
    let error = state
        .plugin
        .configure(&state, "white-noise", false, HashMap::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::FailedPrecondition);
    state
        .plugin
        .persist_settings(&state.plugin.settings.read().unwrap())
        .unwrap();
    let records = PluginStore::new(database).load().unwrap();
    assert!(records["white-noise"].enabled);
    assert_eq!(records["white-noise"].configuration_version, 2);
    assert_eq!(records["white-noise"].metadata["futureSetting"], "keep-me");
}

#[test]
fn storage_and_preferences_resources_cannot_read_other_plugin_or_application_settings() {
    let state = state();
    let database = state.database();
    let first = StorageAccess {
        database: database.clone(),
        plugin_id: "one",
    };
    let second = StorageAccess {
        database: database.clone(),
        plugin_id: "two",
    };
    first.store("key", b"plugin-one").unwrap();
    assert_eq!(first.load("key").unwrap().unwrap(), b"plugin-one");
    assert!(second.load("key").unwrap().is_none());
    database
        .store_kv(
            KV_NAMESPACE_PREFERENCES,
            KV_KEY_SETTINGS,
            br#"{"aiProvider":"openai","aiApiKey":"ai-secret","unrelatedSecret":"other-secret"}"#,
        )
        .unwrap();
    let ai = AiSettingsAccess { database };
    let preferences: serde_json::Value = serde_json::from_slice(&ai.load().unwrap()).unwrap();
    assert_eq!(preferences["aiApiKey"], "ai-secret");
    assert!(preferences.get("unrelatedSecret").is_none());
}

#[test]
fn notification_resource_cannot_modify_another_plugins_notification() {
    let state = state();
    let owner = NotificationAccess {
        hub: state.notifications.clone(),
        source: "owner",
    };
    let other = NotificationAccess {
        hub: state.notifications.clone(),
        source: "other",
    };
    let notification = owner
        .add(NewNotification {
            source_kind: "owner".into(),
            source_id: None,
            kind: "info".into(),
            severity: "info".into(),
            presentation_hint: "center".into(),
            title: "test".into(),
            body: "body".into(),
            url: None,
            actions: vec![],
        })
        .unwrap();
    assert!(other.dismiss(&notification.id).unwrap().is_none());
    assert!(other.mark_actioned(&notification.id).unwrap().is_none());
    assert_eq!(
        owner.notification(&notification.id).unwrap().unwrap().state,
        "unread"
    );
}

#[tokio::test]
async fn a_cancelled_committed_disable_finishes_without_blocking_other_plugin_settings() {
    use neko_plugin::{
        BoxFuture, InvokeReply, InvokeRequest, PluginConfiguration, PluginError, RuntimePlugin,
    };
    use tokio::sync::Notify;
    struct PendingFile {
        entered: Arc<Notify>,
        release: Arc<Notify>,
        cleaned: Arc<Notify>,
    }
    impl RuntimePlugin for PendingFile {
        fn id(&self) -> &'static str {
            "file-transfer"
        }
        fn invoke(&self, _: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
            Box::pin(async {
                self.entered.notify_one();
                self.release.notified().await;
                InvokeReply::json("complete", &json!({}))
            })
        }
        fn configure(
            &self,
            configuration: PluginConfiguration,
        ) -> BoxFuture<'_, Result<(), PluginError>> {
            Box::pin(async move {
                if !configuration.enabled {
                    self.cleaned.notify_one();
                }
                Ok(())
            })
        }
    }
    struct Noise;
    impl RuntimePlugin for Noise {
        fn id(&self) -> &'static str {
            "white-noise"
        }
    }
    fn registration(plugin: Arc<dyn RuntimePlugin>) -> neko_plugin::Registration {
        let entry = super::catalog::ENTRIES
            .iter()
            .find(|entry| entry.id == plugin.id())
            .unwrap();
        neko_plugin::Registration {
            manifest: serde_json::from_str(entry.json).unwrap(),
            resources: neko_plugin::Resources::default(),
            plugin: Ok(plugin),
            configuration: true.into(),
        }
    }
    let state = state();
    let pending = Arc::new(PendingFile {
        entered: Arc::default(),
        release: Arc::default(),
        cleaned: Arc::default(),
    });
    let runtime = neko_plugin::Runtime::start(vec![
        registration(pending.clone()),
        registration(Arc::new(Noise)),
    ])
    .await
    .unwrap();
    assert!(state.plugin.runtime.set(runtime).is_ok());
    let invoke_state = state.clone();
    let invoke = tokio::spawn(async move {
        invoke_state
            .plugin
            .runtime(&invoke_state)
            .await
            .unwrap()
            .invoke(
                "file-transfer",
                InvokeRequest {
                    target: neko_plugin::TargetRequest::default(),
                    operation: "list".into(),
                    content_type: "application/json".into(),
                    payload: vec![],
                },
            )
            .await
    });
    pending.entered.notified().await;
    let configure_state = state.clone();
    let configure = tokio::spawn(async move {
        configure_state
            .plugin
            .configure(&configure_state, "file-transfer", false, HashMap::new())
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while state.plugin.settings.read().unwrap()["file-transfer"].enabled {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("disable is committed before waiting for the active request");
    configure.abort();
    let _ = configure.await;
    let other_result = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        state.plugin.configure(
            &state,
            "white-noise",
            false,
            HashMap::from([("autoPlayOnSelect".into(), "false".into())]),
        ),
    )
    .await;
    pending.release.notify_one();
    invoke.await.unwrap().unwrap();
    other_result
        .expect("another plugin must be configurable while this plugin drains")
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        pending.cleaned.notified(),
    )
    .await
    .expect("committed cleanup must survive a cancelled RPC");
    let saved = PluginStore::new(state.database()).load().unwrap();
    assert!(!saved["file-transfer"].enabled);
    assert!(!saved["white-noise"].enabled);
    state.plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn disabling_file_transfer_discards_only_transient_upload_buffers() {
    let state = state();
    let progress = state
        .plugin
        .file_uploads
        .begin("owner", "/tmp/test", "test", 0)
        .unwrap();
    let upload_id = progress["uploadId"].as_str().unwrap();
    state
        .plugin
        .configure(&state, "file-transfer", false, HashMap::new())
        .await
        .unwrap();
    assert!(
        state
            .plugin
            .file_uploads
            .finish("owner", upload_id)
            .is_err()
    );
    assert!(state.plugin.settings.read().unwrap()["pomodoro"].enabled);
    state
        .plugin
        .configure(&state, "file-transfer", true, HashMap::new())
        .await
        .unwrap();
    assert!(
        state
            .plugin
            .file_uploads
            .begin("owner", "/tmp/next", "next", 0)
            .is_ok()
    );
    state.plugin.shutdown().await.unwrap();
}
