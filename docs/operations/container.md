# Containerized Cockpit

The Spark container boundary is the central Cockpit, not the machine-local
daemon. Cockpit owns its database and Web surface in one persistent volume.
Daemons stay native on workstations so they can own local workspaces,
credentials, processes, and Unix lifecycle integration without broad host
mounts or a Docker socket.

The image builds the same aggregate npm artifact used by a release, then copies
only that artifact and its production dependencies into a non-root runtime
stage.

Release tags publish a multi-architecture image to
`ghcr.io/zendev-lab/spark`. Stable releases publish the exact version and
`latest`; prereleases publish only their exact version. The release workflow
uses its repository-scoped `GITHUB_TOKEN`, so no long-lived registry token is
required.

## Build

From a clean Spark source checkout:

```sh
docker build \
  --build-arg SPARK_BUILD_GIT_SHA="$(git rev-parse HEAD)" \
  --tag spark-cockpit:local \
  .
```

`SPARK_BUILD_GIT_SHA` defaults to `container-build` for ad hoc builds. Pass the
commit SHA for any retained or deployed image so Cockpit build diagnostics are
traceable.

## Local smoke run

Use a named volume so Docker initializes it for the image's non-root user:

```sh
docker volume create spark-cockpit-data
docker run --detach \
  --name spark-cockpit \
  --publish 127.0.0.1:5173:5173 \
  --restart unless-stopped \
  --volume spark-cockpit-data:/var/lib/spark \
  spark-cockpit:local
```

Check both Docker health and the public health endpoint:

```sh
docker inspect --format '{{.State.Health.Status}}' spark-cockpit
curl --fail http://127.0.0.1:5173/api/v1/health
```

Create the one-time Cockpit browser key against the same persistent state:

```sh
docker exec spark-cockpit spark cockpit access create
```

Image replacement owns container upgrades, so the image defaults Spark's
self-update policy to `manual`. Rebuild or pull a newer image, then replace the
container while retaining `spark-cockpit-data`.

For a published stable image, replace `spark-cockpit:local` with
`ghcr.io/zendev-lab/spark:latest`. Pin an exact version for reproducible
deployments. Publishing an image does not restart a running deployment; the
Linux host still owns its pull-and-recreate policy.

## Reverse proxy boundary

Do not publish port 5173 on a public interface, mount host workspaces, or mount
`/var/run/docker.sock`. The initial supported run binds the published port to
host loopback.

Spark currently trusts forwarded headers only from a loopback proxy. A Caddy
container on a separate Docker network is therefore not yet a supported trusted
proxy boundary. Keep the current Caddy/Cloudflare route out of service until the
container network is explicit and Spark can validate the proxy source instead
of broadly trusting forwarded headers.
