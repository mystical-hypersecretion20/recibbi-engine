# PaddleOCR sidecar troubleshooting

Symptom → cause → fix for every PaddleOCR failure mode hit in this project. Read
the matching row first; the diagnostic commands at the bottom confirm which one
you're in.

## Diagnostic-first

When a paddle receipt goes `failed` or a sidecar is `unhealthy`, the cause is
almost always one of the rows below. Identify it before changing anything:

```bash
export PATH="/opt/podman/bin:$PATH"
P=receipt-enricher   # or test-receipt-enricher for the acceptance stack
# Did the sidecar crash / OOM / restart?
podman inspect ${P}_ocr-paddle-vl_1 --format 'Restart={{.RestartCount}} OOM={{.State.OOMKilled}} Exit={{.State.ExitCode}} Status={{.State.Status}}'
# What did the sidecar actually log?
podman logs --tail 20 ${P}_ocr-paddle-vl_1 2>&1 | grep -iE 'error:|libGL|static graph|loaded|listening|BrokenPipe'
# What error did the WORKER get back?
podman logs --tail 20 ${P}_worker_1 2>&1 | grep -i '"err"'
# Is the model warm yet?
podman exec ${P}_ocr-paddle-vl_1 python -c "import urllib.request,json;print(json.load(urllib.request.urlopen('http://127.0.0.1:8090/health')))"
```

`OOMKilled=true` / `Exit=137` → row 2. Sidecar log `libGL` → row 1. Sidecar log
`static graph` → row 3. Worker `err` = `fetch failed` with sidecar healthy →
row 4. Worker `err` = `timed out after Nms` (+ sidecar `BrokenPipeError`) →
row 5.

## 1. `libGL.so.1: cannot open shared object file`

- **Where:** VL sidecar, on import (`from paddleocr import PaddleOCRVL` → cv2).
  Container never reaches `ready`; dies seconds after start.
- **Cause:** `paddlex[ocr]` (a VL-only dep) installs the **GUI** build of OpenCV,
  whose `cv2` needs `libGL.so.1`. PP-OCRv6 doesn't pull `paddlex[ocr]`, so it's
  unaffected — which is why only VL hits this.
- **Fix:** ensure `libgl1` is in `services/ocr-paddle-vl/Dockerfile`'s
  `apt-get install` line (alongside `libgomp1 libglib2.0-0`). Rebuild the image.

## 2. OOM-killed (`OOMKilled=true`, `Exit=137`)

- **Where:** VL sidecar, during model load (weights phase) or mid-inference.
  Model load shows `Loading weights file ... model.safetensors` then the
  container vanishes; `RestartCount` climbs (it has `restart: unless-stopped`),
  and the worker sees `fetch failed` while it's down/reloading.
- **Cause:** the VL bundle (0.9B VLM + layout/doc-ori/unwarp) exceeds the podman
  VM's RAM under emulation. 8 GiB OOMs on load; the full stack (node api+worker+
  redis sharing the VM) needs ≥12 GiB for VL inference too.
- **Fix:** bump the VM, then revert when done:
  ```bash
  podman machine stop
  podman machine set --memory 12288        # 12 GiB; retry start if vfkit aborts
  podman machine start                     # may need 1–2 retries (transient vfkit abort)
  ```
  On a 16 GiB host, **12 GiB is the practical ceiling** — 14 GiB leaves macOS
  ~2 GiB and crashed podman during image builds (row 6). Also pin worker
  `QUEUE_CONCURRENCY=1` so only one VL inference runs at a time (max headroom).

## 3. `int(Tensor) is not supported in static graph mode`

- **Where:** VL sidecar, 500 response: `error: Exception from the 'vlm' worker:
  int(Tensor) is not supported in static graph mode`.
- **Cause:** the VL pipeline runs the VLM in a worker **thread**. The
  static-engine aux models (layout/doc-orientation/unwarping) flip paddle's
  *process-global* graph mode to static, and the VLM thread inherits it; the VLM
  needs dynamic (imperative) mode. Native arm64 happened to avoid the race;
  amd64 emulation timing trips it, especially on the 2nd+ receipt of a run.
- **Fix:** the dynamic-mode guard in `services/ocr-paddle-vl/server.py` —
  `import paddle; if not paddle.in_dynamic_mode(): paddle.disable_static()` right
  before `pipeline.predict(...)`. Keep it. (Toggling `FLAGS_enable_pir_api` does
  NOT help — verified.)

## 4. `fetch failed` after ~300 s, sidecar healthy

- **Where:** worker `err: ... OCR request to http://ocr-paddle-vl:8090/ocr
  failed: fetch failed`, repeating at ~300–310 s intervals, while
  `podman inspect` shows the sidecar up, `RestartCount=0`, no error in its log.
- **Cause:** Node's global `fetch` (undici) imposes a default **300 s
  `headersTimeout`** that fires regardless of any AbortController. A VL inference
  legitimately exceeds 5 min, so the client aborts while the sidecar is still
  working.
- **Fix:** already done — `src/ocr/rest.js` uses the built-in `http`/`https`
  client (no hidden headers timeout), bounded only by `OCR_REST_TIMEOUT_MS`. Do
  not change it back to `fetch`. If you must, you'd need an undici `Agent`
  dispatcher with raised `headersTimeout`/`bodyTimeout`, but undici isn't
  require-able in this Node 20 build — hence the `http` rewrite.

## 5. `timed out after Nms` (+ sidecar `BrokenPipeError`)

- **Where:** worker `err: ... failed: timed out after 600000ms`; the VL sidecar
  log shows `BrokenPipeError: [Errno 32] Broken pipe` (it was still streaming the
  response when the client hung up).
- **Cause:** the per-request ceiling (`OCR_REST_TIMEOUT_MS`, default 600000 =
  10 min) is shorter than a complex VL receipt (~11–14 min emulated).
- **Fix:** raise `OCR_REST_TIMEOUT_MS` (e.g. `1200000` = 20 min) on api+worker,
  and set the acceptance `RE_TEST_POLL_TIMEOUT` to match (≥ the timeout in
  seconds) so the corpus step waits long enough. Optionally reduce
  `PADDLEOCR_VL_MAX_NEW_TOKENS`/`PADDLEOCR_VL_MAX_PIXELS` to shave time.

## 6. Build fails: overlay `input/output error` / `Post "http://d/.../build": EOF`

- **Where:** `podman-compose ... up --build` (or `build`) — heavy paddle image
  layers fail to mount, or the podman API drops mid-build.
- **Cause:** the VM's container storage got corrupted (repeated OOM kills + VM
  memory changes), and/or the VM is memory-starved (14 GiB on a 16 GiB host)
  destabilizing the podman service.
- **Fix, in order:**
  1. `podman system prune -f` (reclaims dangling build layers) then retry.
  2. `podman machine stop && podman machine start` (clears stuck overlay mounts);
     keep the VM at ≤12 GiB so the host isn't starved.
  3. **Avoid the rebuild entirely** if the images already exist and you only need
     a Node-side code change: bind-mount the fixed `src/` over `/app/src` with a
     throwaway `docker-compose.override.yml` and `up` *without* `--build`:
     ```yaml
     services:
       api:    { volumes: [ "receipt-data:/app/data", "./src:/app/src:ro" ] }
       worker: { volumes: [ "receipt-data:/app/data", "./src:/app/src:ro" ] }
     ```
     Verify it took: `podman exec <proj>_worker_1 grep -c http.request /app/src/ocr/rest.js`.
     Remove the override after — it must not be committed.
  4. Last resort: `podman machine reset` (wipes ALL images; the ~2 GB VL image
     then rebuilds from scratch — slow, and pip may hit TLS interception — and the
     base-image pull then hits row 7).

## 7. Build fails at base-image pull: `x509: certificate signed by unknown authority`

- **Where:** the very first build step — `Trying to pull
  docker.io/library/python:3.x-slim... Error: creating build container: ...
  pinging container registry registry-1.docker.io: ... tls: failed to verify
  certificate`. Nothing builds; the failure is before any `RUN` step.
- **Cause:** the TLS-intercepting proxy intercepts the **registry** pull. That trust
  path is **separate** from pip's — the CA certs staged into `services/*/certs/`
  are copied into the image and only fix pip *during* the build, not the
  base-image pull that happens *first*. You only hit this when the base image
  isn't already cached: a fresh `podman machine`, after `podman machine reset`, or
  after an aggressive prune wiped the base layers (`podman images` shows nothing).
- **Fix:** install the internal CA bundle into the **podman VM's** OS trust store
  (Fedora CoreOS), then rebuild:
  ```bash
  cat services/ocr-paddle/certs/*.crt | podman machine ssh \
    'sudo tee /etc/pki/ca-trust/source/anchors/internal-ca-bundle.crt >/dev/null && sudo update-ca-trust'
  # verify: podman machine ssh 'ls -la /etc/pki/ca-trust/source/anchors/'
  ```
  Persists across `podman machine stop/start`; a `podman machine reset` wipes it,
  so re-run after a reset. (`--tls-verify=false` also works but disables
  verification globally — prefer trusting the CA.)

## Quick standalone probe (isolate the sidecar from the app)

To time or smoke-test a single receipt without the whole stack:

```bash
export PATH="/opt/podman/bin:$PATH"
podman run -d --name vl-probe -p 18093:8090 \
  -e PADDLEOCR_VL_MAX_NEW_TOKENS=128 -e PADDLEOCR_VL_MAX_PIXELS=70000 \
  localhost/ocr-paddle-vl:dev
# wait for ready:true, then:
b64=$(base64 -i path/to/receipt.jpg | tr -d '\n')
printf '{"id":"p","mimeType":"image/jpeg","imageBase64":"%s"}' "$b64" > /tmp/req.json
curl -sS --max-time 1800 -w '\nHTTP %{http_code} in %{time_total}s\n' \
  -X POST -H 'content-type: application/json' --data @/tmp/req.json http://localhost:18093/ocr
podman rm -f vl-probe
```

A clean 200 with text here but failures through the app points at the worker side
(rows 4/5) or memory pressure from the rest of the stack (row 2).
