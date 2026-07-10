#include <iostream>
#include <iomanip>
#include "CameraRemote_SDK.h"
namespace SDK = SCRSDK;
int main() {
    auto v = SDK::GetSDKVersion();
    std::cout << "SDK version: " << ((v>>24)&0xFF) << "." << ((v>>16)&0xFF) << "."
              << std::setfill('0') << std::setw(2) << ((v>>8)&0xFF) << std::endl;
    std::cout.flush();
    bool ok = SDK::Init();
    std::cout << "Init: " << (ok ? "OK" : "FAILED") << std::endl;
    SDK::ICrEnumCameraObjectInfo* list = nullptr;
    auto err = SDK::EnumCameraObjects(&list, 5);
    std::cout << "Enumerate: err=0x" << std::hex << err << std::dec
              << " cameras=" << (list ? list->GetCount() : 0) << std::endl;
    if (list) list->Release();
    SDK::Release();
    std::cout << "Released cleanly." << std::endl;
    return 0;
}
