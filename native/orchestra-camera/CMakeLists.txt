# orchestra-camera — native Sony Camera Remote SDK tool for ORCHESTRA.
# The ORCHESTRA daemon (Node/TS) shells out to this binary to lock camera
# exposure (ISO etc.) over Wi-Fi/USB. Keeps native code out of the daemon.
#
# Requires the Sony Camera Remote SDK vendored at vendor/crsdk (gitignored —
# license-restricted). See README.md for how to populate it.
cmake_minimum_required(VERSION 3.21)
project(orchestra_camera CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(CRSDK "${CMAKE_SOURCE_DIR}/vendor/crsdk")
if(NOT EXISTS "${CRSDK}/lib/libCr_Core.dylib")
  message(FATAL_ERROR "Sony CrSDK not found at ${CRSDK}. See README.md.")
endif()

# sdktest — proven SDK smoke test (Init + enumerate + release). Verifies the
# toolchain end-to-end. Real control tool (connect + set-ISO) lands next.
add_executable(sdktest src/sdktest.cpp)
target_include_directories(sdktest PRIVATE "${CRSDK}/include")
target_link_directories(sdktest PRIVATE "${CRSDK}/lib")
target_link_libraries(sdktest PRIVATE Cr_Core)
# Sony's macOS runtime looks for adapters under
# <executable>/Contents/Frameworks/CrAdapter. Mirror the layout used by the
# official SimpleCli sample so USB/IP enumeration works outside an app bundle.
set_target_properties(sdktest PROPERTIES
  BUILD_RPATH "@executable_path"
  INSTALL_RPATH "@executable_path")

add_custom_command(TARGET sdktest PRE_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory
    "$<TARGET_FILE_DIR:sdktest>/Contents/Frameworks/CrAdapter"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CRSDK}/lib/libCr_Core.dylib"
    "${CRSDK}/lib/libmonitor_protocol.dylib"
    "${CRSDK}/lib/libmonitor_protocol_pf.dylib"
    "$<TARGET_FILE_DIR:sdktest>"
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    "${CRSDK}/lib/CrAdapter"
    "$<TARGET_FILE_DIR:sdktest>/Contents/Frameworks/CrAdapter")

# camlist — enumerate cameras and print model/connection/adaptor details.
# Verified 2026-08-03 against a Sony A7 IV (ILCE-7M4) over USB.
add_executable(camlist src/camlist.cpp)
target_include_directories(camlist PRIVATE "${CRSDK}/include")
target_link_directories(camlist PRIVATE "${CRSDK}/lib")
target_link_libraries(camlist PRIVATE Cr_Core)
set_target_properties(camlist PROPERTIES
  BUILD_RPATH "@executable_path"
  INSTALL_RPATH "@executable_path")

# orchestra-camera — the control tool the ORCHESTRA daemon shells out to.
# Prints JSON: list / get / set (--iso --shutter --fnumber).
add_executable(orchestra-camera src/orchestra_camera.cpp)
target_include_directories(orchestra-camera PRIVATE "${CRSDK}/include")
target_link_directories(orchestra-camera PRIVATE "${CRSDK}/lib")
target_link_libraries(orchestra-camera PRIVATE Cr_Core)
set_target_properties(orchestra-camera PROPERTIES
  BUILD_RPATH "@executable_path"
  INSTALL_RPATH "@executable_path")
