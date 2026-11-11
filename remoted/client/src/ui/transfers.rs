use anyhow::{Context, Result, ensure};
use neko_remoted_protocol::{self as protocol, messages::Operation};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024 * 1024;

pub struct Prepared {
    pub handle: String,
    pub name: String,
    pub size: u64,
    pub digest: String,
    pub upload: bool,
}

pub async fn prepare(
    upload: bool,
    name: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Option<Prepared>> {
    let picked = crate::platform::request(if upload {
        json!({"op":"pickUpload"})
    } else {
        json!({"op":"pickDownload","name":name})
    })
    .await?;
    if picked.is_null() {
        return Ok(None);
    }
    let handle = picked["handle"]
        .as_str()
        .context("文件句柄缺失")?
        .to_owned();
    let result = async {
        ensure!(!cancelled.load(Ordering::Acquire), "传输已取消");
        let mut prepared = Prepared {
            handle: handle.clone(),
            name: picked["name"].as_str().unwrap_or(name).to_owned(),
            size: 0,
            digest: String::new(),
            upload,
        };
        if upload {
            let advertised = picked["size"].as_i64().unwrap_or(-1);
            ensure!(advertised <= MAX_FILE_SIZE as i64, "文件超过 4 GiB 上限");
            let mut hash = Sha256::new();
            loop {
                ensure!(!cancelled.load(Ordering::Acquire), "传输已取消");
                let (bytes, eof) = read(&handle).await?;
                prepared.size = prepared
                    .size
                    .checked_add(bytes.len() as u64)
                    .context("文件大小溢出")?;
                ensure!(prepared.size <= MAX_FILE_SIZE, "文件超过 4 GiB 上限");
                hash.update(&bytes);
                if eof {
                    break;
                }
            }
            prepared.digest = digest(hash);
            crate::platform::request(json!({"op":"seek","handle":handle,"offset":0})).await?;
        }
        ensure!(!cancelled.load(Ordering::Acquire), "传输已取消");
        Ok(prepared)
    }
    .await;
    if result.is_err() {
        cleanup(&handle, upload).await?;
    }
    result.map(Some)
}

pub async fn read(handle: &str) -> Result<(Vec<u8>, bool)> {
    let reply =
        crate::platform::request(json!({"op":"read","handle":handle,"size":protocol::FILE_CHUNK}))
            .await?;
    let bytes = protocol::decode(reply["data"].as_str().unwrap_or(""), protocol::FILE_CHUNK)?;
    let eof = reply["eof"].as_bool().context("文件读取缺少结束标记")?;
    ensure!(eof || !bytes.is_empty(), "文件读取没有进展");
    Ok((bytes, eof))
}

pub async fn cleanup(handle: &str, upload: bool) -> Result<()> {
    crate::platform::request(json!({"op":if upload {"close"} else {"cancel"},"handle":handle}))
        .await?;
    Ok(())
}

pub struct Transfer {
    pub prepared: Prepared,
    pub id: String,
    pub offset: u64,
    pub expected: u64,
    pub sent: u64,
    hash: Sha256,
}

impl Transfer {
    pub fn new(prepared: Prepared, id: String, size: u64) -> Result<Self> {
        ensure!(size <= MAX_FILE_SIZE, "文件超过 4 GiB 上限");
        ensure!(
            !prepared.upload || size == prepared.size,
            "主机返回的文件大小不匹配"
        );
        Ok(Self {
            prepared,
            id,
            offset: 0,
            expected: size,
            sent: 0,
            hash: Sha256::new(),
        })
    }

    pub async fn next_upload(&mut self) -> Result<Operation> {
        if self.offset == self.expected {
            let (bytes, eof) = read(&self.prepared.handle).await?;
            ensure!(bytes.is_empty() && eof, "上传文件在校验后发生变化");
            ensure!(
                digest(self.hash.clone()) == self.prepared.digest,
                "上传文件在校验后发生变化"
            );
            return Ok(Operation::FileCommit {
                transfer: self.id.clone(),
            });
        }
        let (bytes, _) = read(&self.prepared.handle).await?;
        ensure!(
            !bytes.is_empty() && self.offset + bytes.len() as u64 <= self.expected,
            "上传文件大小发生变化"
        );
        self.hash.update(&bytes);
        self.sent = self.offset + bytes.len() as u64;
        Ok(Operation::FileChunk {
            transfer: self.id.clone(),
            offset: self.offset,
            data: protocol::encode(&bytes),
        })
    }

    pub fn progress(&mut self, offset: u64) -> Result<()> {
        ensure!(
            self.prepared.upload
                && offset == self.sent
                && offset > self.offset
                && offset <= self.expected,
            "上传确认偏移不匹配"
        );
        self.offset = offset;
        Ok(())
    }

    pub async fn download(&mut self, offset: u64, data: &str) -> Result<Operation> {
        ensure!(
            !self.prepared.upload && offset == self.offset,
            "下载偏移不匹配"
        );
        let bytes = protocol::decode(data, protocol::FILE_CHUNK)?;
        ensure!(
            !bytes.is_empty() && self.offset + bytes.len() as u64 <= self.expected,
            "下载超过声明大小"
        );
        let reply = crate::platform::request(
            json!({"op":"write","handle":self.prepared.handle,"data":protocol::encode(&bytes)}),
        )
        .await?;
        ensure!(reply.as_u64() == Some(bytes.len() as u64), "文件写入不完整");
        self.hash.update(&bytes);
        self.offset += bytes.len() as u64;
        Ok(Operation::TransferAcknowledge {
            transfer: self.id.clone(),
            offset: self.offset,
        })
    }

    pub fn verify(&self, size: u64, sha256: &str) -> Result<()> {
        ensure!(size == self.expected && self.offset == size, "传输未完成");
        ensure!(
            sha256 == digest(self.hash.clone()),
            "SHA-256 校验失败，文件未提交"
        );
        ensure!(
            !self.prepared.upload || sha256 == self.prepared.digest,
            "上传内容校验失败"
        );
        Ok(())
    }

    pub async fn complete(&self) -> Result<()> {
        let op = if self.prepared.upload {
            "close"
        } else {
            "commit"
        };
        crate::platform::request(json!({"op":op,"handle":self.prepared.handle})).await?;
        Ok(())
    }
}

pub fn digest(hash: Sha256) -> String {
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn remote_path(directory: &str, name: &str) -> Result<String> {
    ensure!(
        !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0']),
        "文件名无效"
    );
    Ok(if directory.is_empty() {
        name.to_owned()
    } else {
        format!("{}/{name}", directory.trim_end_matches('/'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_requires_matching_count_and_streaming_digest() {
        let prepared = Prepared {
            handle: "test".into(),
            name: "test".into(),
            size: 0,
            digest: String::new(),
            upload: false,
        };
        let mut transfer = Transfer::new(prepared, "id".into(), 3).unwrap();
        transfer.hash.update(b"abc");
        let hash = digest(transfer.hash.clone());
        assert!(transfer.verify(3, &hash).is_err());
        transfer.offset = 3;
        assert!(transfer.verify(3, &hash).is_ok());
        assert!(transfer.verify(3, &"0".repeat(64)).is_err());
    }

    #[test]
    fn upload_rejects_unsent_or_duplicate_confirmation() {
        let prepared = Prepared {
            handle: "test".into(),
            name: "test".into(),
            size: 10,
            digest: String::new(),
            upload: true,
        };
        let mut transfer = Transfer::new(prepared, "id".into(), 10).unwrap();
        transfer.sent = 5;
        assert!(transfer.progress(6).is_err());
        transfer.progress(5).unwrap();
        assert!(transfer.progress(5).is_err());
    }

    #[test]
    fn listing_names_cannot_escape_current_directory() {
        for name in ["..", ".", "a/b", "a\\b", ""] {
            assert!(remote_path("root", name).is_err());
        }
        assert_eq!(remote_path("dir", "小橘.txt").unwrap(), "dir/小橘.txt");
    }
}
