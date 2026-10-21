//! The storage library stays in this file. The rest of the app only sees
//! UploadTarget, so swapping libraries means changing only this file.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use object_store::aws::AmazonS3Builder;
use object_store::path::Path as ObjectPath;
use object_store::{Attribute, Attributes, ClientOptions, ObjectStore, PutOptions, PutPayload};
use serde::{Deserialize, Serialize};

/// Connection settings for an S3 or S3-compatible bucket.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    // Empty for real AWS S3; set for S3-compatible stores like R2 or MinIO.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    // MinIO and some others need path-style URLs instead of a bucket subdomain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_path_style: Option<bool>,
    // Put in front of every object key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalConfig {
    // Folder the files are written into, like a mounted volume served elsewhere.
    pub path: String,
}

pub enum UploadTarget {
    Local(PathBuf),
    S3 { store: Arc<dyn ObjectStore>, prefix: String },
}

/// The write target for a destination, from its type and JSON config.
pub fn build_target(kind: &str, config: &str) -> Result<UploadTarget> {
    match kind {
        "local" => {
            let c: LocalConfig = serde_json::from_str(config).context("reading the local destination settings")?;
            Ok(UploadTarget::Local(PathBuf::from(c.path)))
        }
        "s3" => {
            let c: S3Config = serde_json::from_str(config).context("reading the S3 destination settings")?;
            let endpoint = c.endpoint.as_deref().map(str::trim).filter(|e| !e.is_empty());
            let path_style = c.force_path_style.unwrap_or(false);
            let mut builder = AmazonS3Builder::new()
                .with_region(&c.region)
                .with_bucket_name(&c.bucket)
                .with_access_key_id(&c.access_key_id)
                .with_secret_access_key(&c.secret_access_key)
                .with_virtual_hosted_style_request(!path_style)
                .with_client_options(ClientOptions::new().with_allow_http(true));
            if let Some(endpoint) = endpoint {
                // Virtual-hosted requests go to the bucket's own subdomain, which
                // object_store expects to be spelled out in the endpoint.
                let endpoint = if path_style { endpoint.to_string() } else { bucket_endpoint(endpoint, &c.bucket)? };
                builder = builder.with_endpoint(endpoint);
            }
            let store = builder.build().context("setting up the S3 client")?;
            let prefix = c.prefix.unwrap_or_default().trim_matches('/').to_string();
            Ok(UploadTarget::S3 { store: Arc::new(store), prefix })
        }
        other => bail!("Unknown destination type \"{other}\""),
    }
}

fn bucket_endpoint(endpoint: &str, bucket: &str) -> Result<String> {
    let mut url = url::Url::parse(endpoint).context("reading the S3 endpoint")?;
    let host = url.host_str().context("the S3 endpoint has no host")?.to_string();
    url.set_host(Some(&format!("{bucket}.{host}"))).context("building the bucket address")?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

impl UploadTarget {
    pub async fn write(&self, path: &str, contents: &str) -> Result<()> {
        let path = path.trim_start_matches('/');
        match self {
            UploadTarget::Local(root) => {
                let full = root.join(path);
                if let Some(dir) = full.parent() {
                    tokio::fs::create_dir_all(dir).await.with_context(|| format!("creating {}", dir.display()))?;
                }
                tokio::fs::write(&full, contents).await.with_context(|| format!("writing {}", full.display()))?;
                Ok(())
            }
            UploadTarget::S3 { store, prefix } => {
                let key = if prefix.is_empty() { path.to_string() } else { format!("{prefix}/{path}") };
                let mut attributes = Attributes::new();
                let mime = mime_guess::from_path(path).first_or_text_plain();
                attributes.insert(Attribute::ContentType, mime.essence_str().to_string().into());
                store
                    .put_opts(
                        &ObjectPath::from(key),
                        PutPayload::from(contents.as_bytes().to_vec()),
                        PutOptions { attributes, ..Default::default() },
                    )
                    .await
                    .context("uploading to S3")?;
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writes_a_file_through_the_local_target() {
        let dir = tempfile::tempdir().unwrap();
        let config = serde_json::json!({ "path": dir.path() }).to_string();
        let target = build_target("local", &config).unwrap();
        target.write("nested/hello.txt", "hi there").await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("nested/hello.txt")).unwrap(), "hi there");
    }

    #[test]
    fn builds_an_s3_target_from_config() {
        let config = serde_json::json!({
            "region": "us-east-1", "bucket": "my-bucket", "accessKeyId": "key", "secretAccessKey": "secret",
            "endpoint": "http://localhost:9000", "forcePathStyle": true,
        });
        assert!(build_target("s3", &config.to_string()).is_ok());
        let virtual_hosted = serde_json::json!({
            "region": "auto", "bucket": "b", "accessKeyId": "k", "secretAccessKey": "s", "endpoint": "https://r2.example.com",
        });
        assert!(build_target("s3", &virtual_hosted.to_string()).is_ok());
        assert_eq!(bucket_endpoint("https://r2.example.com", "b").unwrap(), "https://b.r2.example.com");
    }
}
