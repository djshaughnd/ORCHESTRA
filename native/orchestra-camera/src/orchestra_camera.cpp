// orchestra-camera — Sony camera control for ORCHESTRA.
//
// The Node/TS daemon shells out to this binary; it prints JSON on stdout so
// the daemon can parse it. Keeps native code out of the daemon.
//
//   orchestra-camera list
//   orchestra-camera get   [--index N]
//   orchestra-camera set   [--index N] [--iso 1600] [--shutter <raw>] [--fnumber 400]
//
// ISO values are the SDK's raw CrInt32 encoding (plain ISO numbers for normal
// auto-off values, e.g. 1600). --fnumber is aperture x100 (400 == f/4.0).
// Exit 0 on success, 1 on failure (error text on stderr, JSON on stdout).

#include <atomic>
#include <chrono>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "CameraRemote_SDK.h"
#include "ICrCameraObjectInfo.h"
#include "IDeviceCallback.h"
#include "CrDeviceProperty.h"

namespace SDK = SCRSDK;

namespace {

// Wait for the async Connect handshake / property refresh.
class Callback : public SDK::IDeviceCallback {
public:
    std::atomic<bool> connected{false};
    std::atomic<bool> failed{false};
    std::atomic<CrInt32u> lastError{0};
    std::atomic<bool> propsChanged{false};

    void OnConnected(SDK::DeviceConnectionVersioin) override { connected = true; }
    void OnDisconnected(CrInt32u error) override { lastError = error; connected = false; }
    void OnError(CrInt32u error) override { lastError = error; failed = true; }
    void OnPropertyChanged() override { propsChanged = true; }
    void OnPropertyChangedCodes(CrInt32u, CrInt32u*) override { propsChanged = true; }
};

bool waitFor(const std::atomic<bool>& flag, int timeoutMs) {
    const int step = 50;
    for (int t = 0; t < timeoutMs; t += step) {
        if (flag) return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(step));
    }
    return flag;
}

const char* propName(CrInt32u code) {
    switch (code) {
        case SDK::CrDeviceProperty_IsoSensitivity:     return "iso";
        case SDK::CrDeviceProperty_ShutterSpeed:       return "shutter";
        case SDK::CrDeviceProperty_FNumber:            return "fnumber";
        case SDK::CrDeviceProperty_ExposureProgramMode:return "exposureMode";
        case SDK::CrDeviceProperty_WhiteBalance:       return "whiteBalance";
        case SDK::CrDeviceProperty_Movie_HDMIOutputResolution: return "hdmiResolution";
        default: return nullptr;
    }
}

int argIndex(int argc, char** argv, const char* key) {
    for (int i = 2; i < argc - 1; ++i) if (std::strcmp(argv[i], key) == 0) return i + 1;
    return -1;
}

bool hasArg(int argc, char** argv, const char* key) {
    for (int i = 2; i < argc; ++i) if (std::strcmp(argv[i], key) == 0) return true;
    return false;
}

} // namespace

int main(int argc, char** argv) {
    const std::string cmd = argc > 1 ? argv[1] : "list";
    const int wantIndex = argIndex(argc, argv, "--index") > 0
        ? std::stoi(argv[argIndex(argc, argv, "--index")]) : 0;

    if (!SDK::Init()) { std::cerr << "SDK Init failed\n"; return 1; }

    SDK::ICrEnumCameraObjectInfo* list = nullptr;
    auto err = SDK::EnumCameraObjects(&list, 5);
    if (err != 0 || !list || list->GetCount() == 0) {
        std::cout << "{\"ok\":false,\"cameras\":0,\"error\":\"no camera found\"}\n";
        if (list) list->Release();
        SDK::Release();
        return 1;
    }
    const auto count = list->GetCount();

    if (cmd == "list") {
        std::cout << "{\"ok\":true,\"cameras\":" << count << ",\"devices\":[";
        for (CrInt32u i = 0; i < count; ++i) {
            auto* c = list->GetCameraObjectInfo(i);
            if (i) std::cout << ",";
            std::cout << "{\"index\":" << i
                      << ",\"model\":\"" << (c ? c->GetModel() : "?") << "\""
                      << ",\"connection\":\"" << (c ? c->GetConnectionTypeName() : "?") << "\"}";
        }
        std::cout << "]}\n";
        list->Release(); SDK::Release();
        return 0;
    }

    if ((CrInt32u)wantIndex >= count) {
        std::cout << "{\"ok\":false,\"error\":\"camera index out of range\"}\n";
        list->Release(); SDK::Release(); return 1;
    }

    const auto* info = list->GetCameraObjectInfo(wantIndex);
    Callback cb;
    SDK::CrDeviceHandle handle = 0;
    // Connect takes a non-const pointer; the enum owns the object.
    err = SDK::Connect(const_cast<SDK::ICrCameraObjectInfo*>(info), &cb, &handle);
    if (err != 0) {
        std::cout << "{\"ok\":false,\"error\":\"connect failed 0x" << std::hex << err << "\"}\n";
        list->Release(); SDK::Release(); return 1;
    }
    if (!waitFor(cb.connected, 10000)) {
        std::cout << "{\"ok\":false,\"error\":\"connect timed out (is the camera set to PC Remote?)\"}\n";
        SDK::Disconnect(handle); SDK::ReleaseDevice(handle);
        list->Release(); SDK::Release(); return 1;
    }
    // Give the camera a moment to publish its property table.
    std::this_thread::sleep_for(std::chrono::milliseconds(600));

    int rc = 0;

    if (cmd == "set") {
        struct Target { CrInt32u code; const char* flag; };
        const Target targets[] = {
            { SDK::CrDeviceProperty_IsoSensitivity, "--iso" },
            { SDK::CrDeviceProperty_ShutterSpeed,   "--shutter" },
            { SDK::CrDeviceProperty_FNumber,        "--fnumber" },
            // Movie HDMI output resolution. CrHDMIResolution_1080p = 4.
            // The ATEM Mini Pro ISO cannot lock 4K, so movie mode needs 1080p.
            { SDK::CrDeviceProperty_Movie_HDMIOutputResolution, "--hdmi" },
        };
        bool any = false;
        std::cout << "{\"ok\":true,\"set\":[";
        for (const auto& t : targets) {
            int ai = argIndex(argc, argv, t.flag);
            if (ai < 0) continue;
            const CrInt64u value = std::stoull(argv[ai]);
            SDK::CrDeviceProperty prop;
            prop.SetCode(t.code);
            prop.SetCurrentValue(value);
            prop.SetValueType(SDK::CrDataType_UInt32Array);
            auto serr = SDK::SetDeviceProperty(handle, &prop);
            if (any) std::cout << ",";
            std::cout << "{\"prop\":\"" << (propName(t.code) ? propName(t.code) : "?")
                      << "\",\"value\":" << value
                      << ",\"ok\":" << (serr == 0 ? "true" : "false") << "}";
            if (serr != 0) rc = 1;
            any = true;
        }
        std::cout << "]}\n";
        if (!any) { std::cerr << "set: nothing to do (pass --iso / --shutter / --fnumber)\n"; rc = 1; }
        // let the camera apply + report back
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }

    if (cmd == "dump") {
        SDK::CrDeviceProperty* props = nullptr;
        CrInt32 num = 0;
        auto gerr = SDK::GetDeviceProperties(handle, &props, &num);
        if (gerr == 0 && props) {
            std::cout << "{\"ok\":true,\"model\":\"" << (info ? info->GetModel() : "?")
                      << "\",\"count\":" << num << ",\"properties\":[";
            for (CrInt32 i = 0; i < num; ++i) {
                if (i) std::cout << ",";
                const char* n = propName(props[i].GetCode());
                std::cout << "{\"code\":" << props[i].GetCode()
                          << ",\"name\":\"" << (n ? n : "") << "\""
                          << ",\"value\":" << props[i].GetCurrentValue()
                          << ",\"type\":" << props[i].GetValueType() << "}";
            }
            std::cout << "]}\n";
            SDK::ReleaseDeviceProperties(handle, props);
        } else {
            std::cout << "{\"ok\":false,\"error\":\"GetDeviceProperties 0x" << std::hex << gerr << "\"}\n";
            rc = 1;
        }
    }

    if (cmd == "get" || cmd == "set") {
        SDK::CrDeviceProperty* props = nullptr;
        CrInt32 num = 0;
        auto gerr = SDK::GetDeviceProperties(handle, &props, &num);
        if (gerr == 0 && props) {
            std::cout << "{\"ok\":true,\"model\":\"" << (info ? info->GetModel() : "?")
                      << "\",\"settings\":{";
            bool first = true;
            for (CrInt32 i = 0; i < num; ++i) {
                const char* n = propName(props[i].GetCode());
                if (!n) continue;
                if (!first) std::cout << ",";
                std::cout << "\"" << n << "\":" << props[i].GetCurrentValue();
                first = false;
            }
            std::cout << "}}\n";
            SDK::ReleaseDeviceProperties(handle, props);
        } else {
            std::cout << "{\"ok\":false,\"error\":\"GetDeviceProperties 0x" << std::hex << gerr << "\"}\n";
            rc = 1;
        }
    }

    SDK::Disconnect(handle);
    SDK::ReleaseDevice(handle);
    list->Release();
    SDK::Release();
    return rc;
}
