#ifndef RUNNER_UTILS_H_
#define RUNNER_UTILS_H_

#include <string>
#include <vector>

void CreateAndAttachConsole();
std::vector<std::string> GetCommandLineArguments();
std::wstring Utf16FromUtf8(const std::string& string);
std::string Utf8FromUtf16(const std::wstring& string);

#endif  // RUNNER_UTILS_H_
