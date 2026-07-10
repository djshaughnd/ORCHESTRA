# orchestra-camera — Sony camera control for ORCHESTRA (V3 / ticket C4)

A small native binary the ORCHESTRA daemon shells out to, to control the Sony
cameras over the **Camera Remote SDK** — primarily to **lock ISO/exposure** when
a session starts, so the cameras don't crank ISO in a dark room (the grain fix).
Native C++ stays out of the Node/TS daemon; the daemon just runs this and reads
its exit code / stdout.

## Status (2026-07-09)

**SDK verified working on this Mac.** Built native arm64, `SDK::Init()` returns OK,
enumerate + release run cleanly (`sdktest`). SDK version 2.2.00. The dylibs are
**universal (x86_64 + arm64)** — no Rosetta. Both `libCr_PTP_USB` and
`libCr_PTP_IP` (Wi-Fi/Ethernet) adapters present, so **wireless control works**.

**Not yet built:** the actual connect + set-ISO tool (needs a camera on the line
to develop/verify — the connect handshake is async/callback-driven).

## Prerequisites

- Xcode Command Line Tools (clang), CMake 3.21+ (`brew install cmake`).
- The **Sony Camera Remote SDK** vendored at `vendor/crsdk/` (gitignored):
  - `vendor/crsdk/include/` — the `CRSDK/*.h` headers
  - `vendor/crsdk/lib/` — `libCr_Core.dylib`, `libmonitor_protocol*.dylib`, and
    `CrAdapter/` (libCr_PTP_USB, libCr_PTP_IP, libusb, libssh2)
  - Source: download CrSDK from https://support.d-imaging.sony.co.jp/app/sdk/,
    unzip `RemoteCli.zip`, copy `external/crsdk/*` → `vendor/crsdk/lib/` and
    `app/CRSDK/*.h` → `vendor/crsdk/include/`.
  - **Clear quarantine** on the dylibs or they won't load:
    `xattr -dr com.apple.quarantine vendor/`

## Build & verify

```bash
cmake -S . -B build -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DCMAKE_CXX_FLAGS="-Wno-error=return-mismatch -Wno-error=return-type"
cmake --build build
./build/sdktest      # prints SDK version, Init: OK, enumerate count
```

## Next: the control tool (needs a camera)

Base it on Sony's `SimpleCli` samples (`connect.cpp`, `CreateCameraObjectInfo.cpp`,
`getSetDevicePropertyStr.cpp`). Confirmed API path:

- **Connect over Wi-Fi/Ethernet:** `CreateCameraObjectInfoEthernetConnection(&objInfo,
  model, ipAddress, macAddress, sshSupport)` — pack IP as `ip |= octet << (i*8)` —
  then `Connect(objInfo, &callback, &handle, ...)` (async; wait for `OnConnected`).
  USB path: `EnumCameraObjects` → pick device → `Connect`.
- **Lock ISO:** build a `CrDeviceProperty`, code `CrDeviceProperty_IsoSensitivity`,
  set value + type, `SetDeviceProperty(handle, &devProp)`. (Also
  `CrDeviceProperty_IsoCurrentSensitivity` to read back.)
- Wrap as a non-interactive CLI: `orchestra-camera lock-iso --ip <addr> --model <m> --iso <v>`,
  exit 0 on success. Daemon calls it per camera on `/go`.

Wire into ORCHESTRA: a `cameras:` block per profile (ip/model/iso), invoked from
the session-start flow. See ../../docs/sdk-references.md and HANDOFF.md.
