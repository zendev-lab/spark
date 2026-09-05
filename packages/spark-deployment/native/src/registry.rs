use crate::model::{AvailableRelease, UpdateChannel};
use semver::Version;
use serde::Deserialize;
use std::collections::BTreeMap;

const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";
const PACKAGE_NAME: &str = "@zendev-lab/spark";

#[derive(Clone, Debug, Default, Deserialize)]
struct NpmDistribution {
    integrity: Option<String>,
    tarball: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NpmEngines {
    node: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NpmVersionMetadata {
    version: Option<String>,
    dist: Option<NpmDistribution>,
    engines: Option<NpmEngines>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct NpmPackument {
    #[serde(rename = "dist-tags")]
    dist_tags: BTreeMap<String, String>,
    versions: BTreeMap<String, NpmVersionMetadata>,
}

pub(crate) fn registry_root() -> String {
    std::env::var("SPARK_NPM_REGISTRY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_REGISTRY.to_owned())
        .trim_end_matches('/')
        .to_owned()
}

fn package_path() -> &'static str {
    "%40zendev-lab%2Fspark"
}

pub fn query_channel(
    channel: &UpdateChannel,
    etag: Option<&str>,
) -> Result<AvailableRelease, String> {
    let url = format!("{}/{}", registry_root(), package_path());
    let mut request = ureq::get(&url).header("accept", "application/vnd.npm.install-v1+json");
    if let Some(etag) = etag {
        request = request.header("if-none-match", etag);
    }
    match request.call() {
        Ok(mut response) => {
            let response_etag = response
                .headers()
                .get("etag")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let packument: NpmPackument = response
                .body_mut()
                .read_json()
                .map_err(|error| format!("npm registry returned invalid metadata: {error}"))?;
            let version = packument.dist_tags.get(channel.as_str()).ok_or_else(|| {
                format!(
                    "npm package {PACKAGE_NAME} has no {} dist-tag",
                    channel.as_str()
                )
            })?;
            release_from_metadata(packument.versions.get(version), response_etag, false)
        }
        Err(ureq::Error::StatusCode(304)) => Ok(AvailableRelease {
            version: String::new(),
            integrity: String::new(),
            tarball: String::new(),
            node_requirement: None,
            etag: etag.map(str::to_owned),
            not_modified: true,
        }),
        Err(error) => Err(format!("npm registry request failed: {error}")),
    }
}

pub fn query_exact(version: &str) -> Result<AvailableRelease, String> {
    Version::parse(version)
        .map_err(|_| format!("Expected an exact semantic version, received: {version}"))?;
    let url = format!("{}/{}/{}", registry_root(), package_path(), version);
    let mut response = ureq::get(&url)
        .header("accept", "application/json")
        .call()
        .map_err(|error| format!("npm registry request failed: {error}"))?;
    let metadata: NpmVersionMetadata = response
        .body_mut()
        .read_json()
        .map_err(|error| format!("npm registry returned invalid metadata: {error}"))?;
    release_from_metadata(Some(&metadata), None, false)
}

fn release_from_metadata(
    metadata: Option<&NpmVersionMetadata>,
    etag: Option<String>,
    not_modified: bool,
) -> Result<AvailableRelease, String> {
    let metadata = metadata
        .ok_or_else(|| "npm registry returned incomplete Spark release metadata".to_owned())?;
    let version = metadata
        .version
        .clone()
        .ok_or_else(|| "npm release has no version".to_owned())?;
    Version::parse(&version)
        .map_err(|_| format!("Expected an exact semantic version, received: {version}"))?;
    let distribution = metadata
        .dist
        .as_ref()
        .ok_or_else(|| "npm release has no dist metadata".to_owned())?;
    Ok(AvailableRelease {
        version,
        integrity: distribution
            .integrity
            .clone()
            .ok_or_else(|| "npm release has no integrity".to_owned())?,
        tarball: distribution
            .tarball
            .clone()
            .ok_or_else(|| "npm release has no tarball".to_owned())?,
        node_requirement: metadata
            .engines
            .as_ref()
            .and_then(|engines| engines.node.clone()),
        etag,
        not_modified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exact_integrity_engine_and_etag_metadata() {
        let metadata: NpmVersionMetadata = serde_json::from_str(
            r#"{"version":"0.5.1","dist":{"integrity":"sha512-fixture","tarball":"https://registry.example/spark.tgz"},"engines":{"node":">=24"}}"#,
        )
        .unwrap();
        let release =
            release_from_metadata(Some(&metadata), Some("fixture-etag".to_owned()), false).unwrap();
        assert_eq!(release.version, "0.5.1");
        assert_eq!(release.integrity, "sha512-fixture");
        assert_eq!(release.node_requirement.as_deref(), Some(">=24"));
        assert_eq!(release.etag.as_deref(), Some("fixture-etag"));
    }

    #[test]
    fn rejects_release_metadata_without_registry_integrity() {
        let metadata: NpmVersionMetadata = serde_json::from_str(
            r#"{"version":"0.5.1","dist":{"tarball":"https://registry.example/spark.tgz"}}"#,
        )
        .unwrap();
        assert!(
            release_from_metadata(Some(&metadata), None, false)
                .unwrap_err()
                .contains("integrity")
        );
    }
}
