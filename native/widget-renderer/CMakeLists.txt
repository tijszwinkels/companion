cmake_minimum_required(VERSION 3.21)
project(CompanionWidgets LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_AUTOMOC ON)
find_package(Qt6 6.8 REQUIRED COMPONENTS Quick WebEngineQuick Network QuickTest)

add_library(companionwidgets MODULE profile.cpp plugin.cpp)
target_link_libraries(companionwidgets PRIVATE Qt6::WebEngineQuick Qt6::Network)
set_target_properties(companionwidgets PROPERTIES
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/qml/Companion/Widgets")
configure_file(qmldir "${CMAKE_BINARY_DIR}/qml/Companion/Widgets/qmldir" COPYONLY)

# This runner initializes WebEngine before creating the QML test application.
# It exercises the actual embedded view offscreen, without a desktop shell.
add_executable(companion-widget-tests test-main.cpp)
target_link_libraries(companion-widget-tests PRIVATE Qt6::WebEngineQuick Qt6::QuickTest)
