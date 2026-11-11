# OpenShift deployment

Deploys the sharing service into an OpenShift project using the cluster's own
build and registry. No external registry, no npm install, no reverse proxy: TLS
terminates at the ingress router and the pod stays on plain HTTP behind a Service.

The result is the same service described in the [main README](../../README.md),
reachable at `https://<route-host>/pi-history`.

## What gets created

| Object | Purpose |
| --- | --- |
| `ImageStream/pi-history` | Holds the built image inside the cluster. |
| `BuildConfig/pi-history` | Binary Docker build of the repository `Dockerfile`. |
| `PersistentVolumeClaim/pi-history-data` | SQLite storage, `ReadWriteOnce`, 1 Gi. |
| `ConfigMap/pi-history-config` | `PUBLIC_URL`, which also sets the route prefix. |
| `Secret/pi-history-secrets` | Team upload key (`UPLOAD_KEY`), generated on first deploy. |
| `Deployment/pi-history` | One replica of `node server/index.mjs` on port 9080. |
| `Service/pi-history` | Cluster-internal port 9080. |
| `Route/pi-history` | Edge TLS on path `/pi-history`, redirects HTTP to HTTPS. |
| `NetworkPolicy/pi-history-allow-router` | Optional; installs only with `PI_HISTORY_ALLOW_ROUTER=1`. |

## Quick start

```sh
oc login ...            # a project where you can create builds, deployments and routes
./deploy/openshift/deploy.sh
```

Pass a project name to deploy elsewhere: `./deploy/openshift/deploy.sh my-project`.
The script is idempotent. It builds the image, applies everything, reads the
assigned route hostname, writes `PUBLIC_URL`, derives the required `fsGroup` from
the project, waits for the rollout, and prints the viewer URL plus publisher
settings. The first run prints the generated upload key; later runs keep it.

Point publishers at the deployment, from the shell where Pi starts:

```sh
export PI_SHARE_URL=https://<route-host>/pi-history
export PI_SHARE_KEY='<the UPLOAD_KEY value>'
pi
```

Read the key again with:

```sh
oc get secret pi-history-secrets -o jsonpath='{.data.UPLOAD_KEY}' | base64 -d; echo
```

## Manual deployment

The manifests are plain YAML and can be applied without the script, but four
things are project- or build-specific and must be set by hand.

1. Build and push the image into the project's registry:

   ```sh
   oc apply -f deploy/openshift/imagestream.yaml -f deploy/openshift/buildconfig.yaml
   oc start-build pi-history --from-dir=. --follow
   ```

2. Apply the storage, service and route, then read the route hostname:

   ```sh
   oc apply -f deploy/openshift/pvc.yaml -f deploy/openshift/service.yaml
   oc apply -f deploy/openshift/route.yaml
   oc get route pi-history -o jsonpath='{.spec.host}'
   ```

3. Create the ConfigMap with `PUBLIC_URL` set to `https://<route-host>/pi-history`,
   matching the route path exactly, and create the upload key:

   ```sh
   oc create configmap pi-history-config \
     --from-literal=PUBLIC_URL="https://<route-host>/pi-history"
   oc create secret generic pi-history-secrets \
     --from-literal=UPLOAD_KEY="$(openssl rand -hex 32)"
   ```

4. Set `fsGroup` in `deployment.yaml` before applying it. The application stores
   SQLite on the claim, and restricted security context constraints only accept a
   group from the project's allotted range:

   ```sh
   oc get ns "$(oc project -q)" \
     -o jsonpath='{.metadata.annotations.openshift\.io/sa\.scc\.supplemental-groups}'
   # e.g. 1000000000/10000 -> use 1000000000
   ```

   Then apply the Deployment and pin the image, because the pod spec does not
   resolve a bare `ImageStreamTag` name on current OpenShift:

   ```sh
   oc apply -f deploy/openshift/deployment.yaml
   oc set image deployment/pi-history pi-history="$(
     oc get istag pi-history:latest -o jsonpath='{.image.dockerImageReference}')"
   oc rollout status deployment/pi-history
   ```

The `image.openshift.io/triggers` annotation in `deployment.yaml` keeps the image
updated when the tag is rebuilt; the explicit `oc set image` avoids waiting for
the trigger on first rollout.

## Why these settings

- **Path prefix.** `PUBLIC_URL` drives both the generated viewer links and the
  application's own routes, so it must match the Route path. The OpenShift router
  forwards the path unchanged, which is what the application expects. Root
  deployments work too: drop `spec.path` from the Route, set `PUBLIC_URL` to
  `https://<host>`, and change the probe paths to `/health`.
- **Long route timeout.** Live uploads use Server-Sent Events
  (`/pi-history/api/shares/*/events`). The default 30s router idle timeout would
  disconnect every viewer, so the Route sets `haproxy.router.openshift.io/timeout`.
  Cookie stickiness is disabled because there is only one replica.
- **One replica, `Recreate`.** SQLite is a single-writer WAL database on a
  `ReadWriteOnce` block volume. Do not scale the Deployment, use a HorizontalPodAutoscaler,
  or point it at a shared filesystem such as NFS.
- **`fsGroup`.** The container runs as an arbitrary UID assigned by OpenShift, so
  it cannot rely on the image's `chown node:node /data`. Kubernetes applies
  `fsGroup` to the mounted claim to make it writable.
- **Probes.** `/pi-history/health` is served under the prefix and needs no
  credentials.
- **No ingress exposure of 9080.** Only the Route is reachable; the Service is
  cluster-internal.

## Operating it

```sh
oc logs deployment/pi-history            # service log
oc rollout status deployment/pi-history  # after a rebuild
oc start-build pi-history --from-dir=. --follow   # rebuild from a checkout
oc delete route pi-history               # stop public access, keep data
```

- **Backups.** Stop the application briefly and copy the claim, or use a
  SQLite-aware tool: `oc scale deployment/pi-history --replicas=0`, snapshot the
  volume, then scale back to 1. Do not copy only the `.sqlite` file from a running
  database; acknowledged writes may still be in the `-wal` file.
- **Rotate the upload key.** `oc delete secret pi-history-secrets`, then rerun
  `deploy.sh` to generate a new one and restart the pod. Existing per-share owner
  keys keep working, as described in the main README.
- **Wipe data.** Delete the `pi-history-data` claim after scaling to zero, then
  redeploy. `oc delete project` removes everything, including the image.
- **Disk limits.** The default 1 Gi claim holds roughly the same total as the
  application's own per-share quotas allow for a small team; grow the claim if you
  keep many sessions.

## Troubleshooting access

**The Route is `Admitted` and `curl http://pi-history:9080/pi-history/health`
works from another pod, but the route hostname hangs or returns 503.** The
project has a `NetworkPolicy` that limits ingress, typically to one private
router shard, and the Route landed on a router whose pods it does not allow. A
quick tell is the domain root returning the router's 503 page while the route
path never answers. Two options:

- Select the expected shard by labelling the Route with the IngressController's
  `routeSelector` labels. Ask whoever runs the cluster for the selector; the
  shard may also use a different hostname, in which case update `PUBLIC_URL`.
- Allow the ingress namespace, which is what
  `deploy/openshift/netpol-allow-router.yaml` does:

  ```sh
  oc apply -f deploy/openshift/netpol-allow-router.yaml
  # or: PI_HISTORY_ALLOW_ROUTER=1 ./deploy/openshift/deploy.sh
  ```

**`ImagePullBackOff` on `pi-history:latest`.** The pod spec cannot resolve a bare
`ImageStreamTag` name; point the deployment at the built image with
`oc set image` as shown above.

**`CreateContainerConfigError` or `EACCES` on the SQLite file.** `fsGroup` is
missing or outside the project's allowed range.

**HTTP 404 for everything under the domain root.** The Route claims only
`/pi-history`; use the full path, and check that `PUBLIC_URL` matches it.

## Limitations

Published transcripts are public: anyone who can reach the route can browse the
directory and read logs. There is no viewer login. For team-only access, add an
authenticated proxy, mTLS, or IP allowlisting
(`haproxy.router.openshift.io/ip_whitelist`) to the Route.
