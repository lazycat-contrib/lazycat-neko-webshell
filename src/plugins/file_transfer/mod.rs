mod uploads;
pub use uploads::{FileTransferUploadManager, MAX_FILE_TRANSFER_BYTES};

use neko_plugin::{
    BoxFuture, FileOperation, InvokeReply, InvokeRequest, PluginConfiguration, PluginError,
    Resources, RuntimePlugin, TargetFiles,
};
use std::sync::Arc;

pub struct FileTransferResource {
    pub files: Arc<dyn TargetFiles>,
    pub uploads: Arc<FileTransferUploadManager>,
}

pub fn register(resources: &Resources) -> Result<Arc<dyn RuntimePlugin>, PluginError> {
    Ok(Arc::new(FileTransferPlugin {
        resource: resources.require("files")?,
    }))
}

struct FileTransferPlugin {
    resource: Arc<FileTransferResource>,
}
impl RuntimePlugin for FileTransferPlugin {
    fn id(&self) -> &'static str {
        "file-transfer"
    }
    fn invoke(&self, request: InvokeRequest) -> BoxFuture<'_, Result<InvokeReply, PluginError>> {
        Box::pin(async move {
            let metadata = &request.target.metadata;
            let path = || required(metadata, "path").map(str::to_owned);
            let operation = match request.operation.as_str() {
                "default" | "list" => FileOperation::List {
                    path: metadata.get("path").cloned().unwrap_or_else(|| ".".into()),
                },
                "read" | "download" => FileOperation::Read {
                    path: path()?,
                    content_type: request.content_type,
                },
                "stat" => FileOperation::Stat { path: path()? },
                "write" | "upload" => FileOperation::Write {
                    path: path()?,
                    data: request.payload,
                },
                "upload_begin" | "upload_chunk" | "upload_finish" | "upload_cancel" => {
                    let owner = self
                        .resource
                        .files
                        .authorize(&request.target)
                        .await?
                        .upload_owner();
                    let value = match request.operation.as_str() {
                        "upload_begin" => {
                            let path = path()?;
                            let name = metadata
                                .get("name")
                                .filter(|value| !value.trim().is_empty())
                                .map_or_else(
                                    || {
                                        path.rsplit('/')
                                            .find(|part| !part.is_empty())
                                            .unwrap_or("upload")
                                    },
                                    String::as_str,
                                );
                            self.resource.uploads.begin(
                                &owner,
                                &path,
                                name,
                                number(metadata, "size")?,
                            )
                        }
                        "upload_chunk" => self.resource.uploads.append(
                            &owner,
                            required(metadata, "uploadId")?,
                            number(metadata, "offset")?,
                            &request.payload,
                        ),
                        "upload_cancel" => self
                            .resource
                            .uploads
                            .cancel(&owner, required(metadata, "uploadId")?),
                        _ => {
                            let upload = self
                                .resource
                                .uploads
                                .finish(&owner, required(metadata, "uploadId")?)?;
                            let mut reply = self
                                .resource
                                .files
                                .execute(
                                    &request.target,
                                    FileOperation::Write {
                                        path: upload.path,
                                        data: upload.data,
                                    },
                                )
                                .await?;
                            reply.metadata.insert("operation".into(), "upload".into());
                            return Ok(reply);
                        }
                    }
                    .map_err(|error| transfer_error(error, &request.operation))?;
                    let mut reply = InvokeReply::json(
                        if request.operation == "upload_cancel" {
                            "cancelled"
                        } else {
                            "uploading"
                        },
                        &value,
                    )?;
                    reply
                        .metadata
                        .insert("operation".into(), request.operation.clone());
                    if request.operation == "upload_begin" {
                        reply.metadata.insert("path".into(), path()?);
                    }
                    return Ok(reply);
                }
                _ => {
                    return Err(PluginError::invalid_argument(format!(
                        "unsupported file-transfer operation: {}",
                        request.operation
                    )));
                }
            };
            let mut reply = self
                .resource
                .files
                .execute(&request.target, operation)
                .await?;
            reply.metadata.insert("operation".into(), request.operation);
            Ok(reply)
        })
    }
    fn configure(
        &self,
        configuration: PluginConfiguration,
    ) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async move {
            if !configuration.enabled {
                self.resource.uploads.clear()?;
            }
            Ok(())
        })
    }
    fn shutdown(&self) -> BoxFuture<'_, Result<(), PluginError>> {
        Box::pin(async { self.resource.uploads.clear() })
    }
}

fn required<'a>(
    metadata: &'a std::collections::HashMap<String, String>,
    key: &str,
) -> Result<&'a str, PluginError> {
    metadata
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PluginError::invalid_argument(format!("metadata.{key} is required")))
}
fn number(
    metadata: &std::collections::HashMap<String, String>,
    key: &str,
) -> Result<usize, PluginError> {
    required(metadata, key)?
        .parse()
        .map_err(|_| PluginError::invalid_argument(format!("metadata.{key} must be a number")))
}
fn transfer_error(error: PluginError, operation: &str) -> PluginError {
    let message = error.to_string();
    if message.contains("file size is outside the supported transfer limit") {
        PluginError::invalid_argument(format!(
            "{message}; max upload size is {} MB",
            MAX_FILE_TRANSFER_BYTES / 1024 / 1024
        ))
    } else {
        PluginError::invalid_argument(format!("{operation} failed: {message}"))
    }
}
