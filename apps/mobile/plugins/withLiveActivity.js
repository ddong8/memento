const fs = require("fs");
const path = require("path");
const {
  withAppDelegate,
  withInfoPlist,
  withDangerousMod,
  createRunOncePlugin,
} = require("@expo/config-plugins");

const PKG_NAME = "memento-live-activity-plugin";
const PKG_VERSION = "1.0.0";

const ATTRIBUTES_SWIFT = `import ActivityKit
import Foundation

public struct MementoTaskAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var status: String
    public var currentStep: String
    public var stepCount: Int
    public var toolName: String?
    public var elapsedSeconds: Int

    public init(
      status: String = "running",
      currentStep: String = "正在启动任务...",
      stepCount: Int = 1,
      toolName: String? = nil,
      elapsedSeconds: Int = 0
    ) {
      self.status = status
      self.currentStep = currentStep
      self.stepCount = stepCount
      self.toolName = toolName
      self.elapsedSeconds = elapsedSeconds
    }
  }

  public var conversationId: String
  public var title: String
  public var engine: String
  public var deviceName: String
  public var startedAtEpoch: Double

  public init(
    conversationId: String,
    title: String,
    engine: String = "AI",
    deviceName: String = "云端",
    startedAtEpoch: Double = Date().timeIntervalSince1970
  ) {
    self.conversationId = conversationId
    self.title = title
    self.engine = engine
    self.deviceName = deviceName
    self.startedAtEpoch = startedAtEpoch
  }
}
`;

const WIDGET_SWIFT = `import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.2, *)
private struct MementoStatusTheme {
  let status: String

  var isFinished: Bool {
    status == "done" || status == "error" || status == "cancelled"
  }

  var badgeLabel: String {
    switch status {
    case "thinking": return "深度推演"
    case "tool": return "调用工具"
    case "executing": return "终端执行"
    case "generating": return "生成回复"
    case "done": return "已完成"
    case "error": return "任务异常"
    case "cancelled": return "已停止"
    default: return "运行中"
    }
  }

  var iconName: String {
    switch status {
    case "thinking": return "brain.head.profile"
    case "tool", "executing": return "terminal.fill"
    case "generating": return "sparkles"
    case "done": return "checkmark.circle.fill"
    case "error", "cancelled": return "exclamationmark.triangle.fill"
    default: return "bolt.horizontal.circle.fill"
    }
  }

  var accentColor: Color {
    switch status {
    case "done": return Color(red: 0.20, green: 0.83, blue: 0.60)
    case "error", "cancelled": return Color(red: 0.98, green: 0.35, blue: 0.45)
    case "tool", "executing": return Color(red: 0.22, green: 0.74, blue: 0.97)
    case "thinking": return Color(red: 0.66, green: 0.55, blue: 0.98)
    default: return Color(red: 0.55, green: 0.45, blue: 0.98)
    }
  }
}

@available(iOS 16.2, *)
private struct MementoLockScreenView: View {
  let context: ActivityViewContext<MementoTaskAttributes>

  var body: some View {
    let theme = MementoStatusTheme(status: context.state.status)
    let startDate = Date(timeIntervalSince1970: context.attributes.startedAtEpoch)
    let endDate = startDate.addingTimeInterval(28800)

    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        HStack(spacing: 5) {
          Image(systemName: theme.iconName)
            .font(.system(size: 12, weight: .bold))
            .foregroundColor(theme.accentColor)
          Text("Memento · \\(context.attributes.engine)")
            .font(.system(size: 12, weight: .bold, design: .rounded))
            .foregroundColor(.white)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(theme.accentColor.opacity(0.18))
        .clipShape(Capsule())

        Text(context.attributes.deviceName)
          .font(.system(size: 11, weight: .medium))
          .foregroundColor(Color.white.opacity(0.65))
          .lineLimit(1)

        Spacer()

        Text(theme.badgeLabel)
          .font(.system(size: 11, weight: .semibold))
          .foregroundColor(theme.accentColor)

        if !theme.isFinished {
          Text(timerInterval: startDate...endDate, countsDown: false)
            .monospacedDigit()
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundColor(.white)
            .frame(width: 48, alignment: .trailing)
        } else {
          Text("\\(context.state.elapsedSeconds)s")
            .monospacedDigit()
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundColor(Color.white.opacity(0.75))
        }
      }

      Text(context.attributes.title)
        .font(.system(size: 14, weight: .semibold))
        .foregroundColor(.white)
        .lineLimit(1)

      HStack(spacing: 8) {
        Circle()
          .fill(theme.accentColor)
          .frame(width: 6, height: 6)

        Text(context.state.currentStep)
          .font(.system(size: 12, weight: .regular, design: .monospaced))
          .foregroundColor(Color.white.opacity(0.85))
          .lineLimit(1)

        Spacer()

        Text("步骤 #\\(max(1, context.state.stepCount))")
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundColor(Color.white.opacity(0.55))
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(Color.white.opacity(0.07))
      .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
    .padding(14)
    .background(Color(red: 0.05, green: 0.05, blue: 0.09))
  }
}

@available(iOS 16.2, *)
public struct MementoTaskLiveActivity: Widget {
  public init() {}

  public var body: some WidgetConfiguration {
    ActivityConfiguration(for: MementoTaskAttributes.self) { context in
      MementoLockScreenView(context: context)
        .activityBackgroundTint(Color(red: 0.05, green: 0.05, blue: 0.09))
        .activitySystemActionForegroundColor(.white)
        .widgetURL(URL(string: "memento://ask?id=\\(context.attributes.conversationId)&scroll=bottom"))
    } dynamicIsland: { context in
      let theme = MementoStatusTheme(status: context.state.status)
      let startDate = Date(timeIntervalSince1970: context.attributes.startedAtEpoch)
      let endDate = startDate.addingTimeInterval(28800)

      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          HStack(spacing: 6) {
            Image(systemName: theme.iconName)
              .font(.system(size: 14, weight: .bold))
              .foregroundColor(theme.accentColor)
            Text(context.attributes.engine)
              .font(.system(size: 13, weight: .bold, design: .rounded))
              .foregroundColor(.white)
            Text("· \\(context.attributes.deviceName)")
              .font(.system(size: 11, weight: .medium))
              .foregroundColor(Color.white.opacity(0.6))
              .lineLimit(1)
          }
          .padding(.leading, 4)
        }

        DynamicIslandExpandedRegion(.trailing) {
          HStack(spacing: 6) {
            Text(theme.badgeLabel)
              .font(.system(size: 11, weight: .semibold))
              .foregroundColor(theme.accentColor)
            if !theme.isFinished {
              Text(timerInterval: startDate...endDate, countsDown: false)
                .monospacedDigit()
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundColor(.white)
                .frame(width: 46, alignment: .trailing)
            }
          }
          .padding(.trailing, 4)
        }

        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(context.attributes.title)
              .font(.system(size: 13, weight: .semibold))
              .foregroundColor(.white)
              .lineLimit(1)

            HStack(spacing: 6) {
              if let tool = context.state.toolName, !tool.isEmpty {
                Text(tool)
                  .font(.system(size: 10, weight: .bold, design: .monospaced))
                  .foregroundColor(theme.accentColor)
                  .padding(.horizontal, 6)
                  .padding(.vertical, 2)
                  .background(theme.accentColor.opacity(0.18))
                  .clipShape(Capsule())
              }

              Text(context.state.currentStep)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundColor(Color.white.opacity(0.85))
                .lineLimit(1)

              Spacer()

              Text("#\\(max(1, context.state.stepCount))")
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundColor(Color.white.opacity(0.5))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.white.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
          }
          .padding(.top, 4)
        }
      } compactLeading: {
        HStack(spacing: 4) {
          Image(systemName: theme.iconName)
            .font(.system(size: 12, weight: .bold))
            .foregroundColor(theme.accentColor)
          Text(context.attributes.engine)
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .foregroundColor(.white)
            .lineLimit(1)
        }
        .padding(.leading, 2)
      } compactTrailing: {
        if !theme.isFinished {
          Text(timerInterval: startDate...endDate, countsDown: false)
            .monospacedDigit()
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundColor(theme.accentColor)
            .frame(width: 42, alignment: .trailing)
        } else {
          Text(theme.badgeLabel)
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(theme.accentColor)
        }
      } minimal: {
        Image(systemName: theme.iconName)
          .font(.system(size: 12, weight: .bold))
          .foregroundColor(theme.accentColor)
      }
      .widgetURL(URL(string: "memento://ask?id=\\(context.attributes.conversationId)&scroll=bottom"))
      .keylineTint(theme.accentColor)
    }
  }
}

@main
@available(iOS 16.2, *)
struct MementoLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    MementoTaskLiveActivity()
  }
}
`;

const WIDGET_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>$(DEVELOPMENT_LANGUAGE)</string>
\t<key>CFBundleDisplayName</key>
\t<string>Memento 灵动岛</string>
\t<key>CFBundleExecutable</key>
\t<string>$(EXECUTABLE_NAME)</string>
\t<key>CFBundleIdentifier</key>
\t<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>$(PRODUCT_NAME)</string>
\t<key>CFBundlePackageType</key>
\t<string>$(PRODUCT_BUNDLE_PACKAGE_TYPE)</string>
\t<key>CFBundleShortVersionString</key>
\t<string>$(MARKETING_VERSION)</string>
\t<key>CFBundleVersion</key>
\t<string>$(CURRENT_PROJECT_VERSION)</string>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.widgetkit-extension</string>
\t</dict>
</dict>
</plist>
`;

const MANAGER_CODE = `
@available(iOS 16.2, *)
@objc public class MementoLiveActivityManager: NSObject {
  @objc public static let shared = MementoLiveActivityManager()
  private var lastHandledCmdTs: Double = 0
  private var observedActivityIds = Set<String>()
  private var pushToStartObserved = false

  public override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(onDefaultsChanged),
      name: UserDefaults.didChangeNotification,
      object: nil
    )
    setupTokenObservers()
  }

  private func setupTokenObservers() {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

    Task {
      for await activity in Activity<MementoTaskAttributes>.activityUpdates {
        self.observeActivityPushToken(activity)
      }
    }

    if #available(iOS 17.2, *), !pushToStartObserved {
      pushToStartObserved = true
      Task {
        for await tokenData in Activity<MementoTaskAttributes>.pushToStartTokenUpdates {
          let hex = tokenData.map { String(format: "%02x", $0) }.joined()
          self.uploadTokenToServer(pushToStartToken: hex, activityPushToken: nil, conversationId: nil)
        }
      }
    }
  }

  private func observeActivityPushToken(_ activity: Activity<MementoTaskAttributes>) {
    let actId = activity.id
    if observedActivityIds.contains(actId) { return }
    observedActivityIds.insert(actId)
    let convId = activity.attributes.conversationId

    Task {
      for await tokenData in activity.pushTokenUpdates {
        let hex = tokenData.map { String(format: "%02x", $0) }.joined()
        self.uploadTokenToServer(pushToStartToken: nil, activityPushToken: hex, conversationId: convId)
      }
    }
  }

  private func uploadTokenToServer(pushToStartToken: String?, activityPushToken: String?, conversationId: String?) {
    let defaults = UserDefaults.standard
    guard let server = defaults.string(forKey: "memento_server"),
          let token = defaults.string(forKey: "memento_token"),
          !server.isEmpty, !token.isEmpty else {
      return
    }
    let cleanServer = server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let url = URL(string: "\\(cleanServer)/api/notify/live-activity-token") else { return }

    var body: [String: Any] = [:]
    if let pts = pushToStartToken { body["push_to_start_token"] = pts }
    if let act = activityPushToken { body["activity_push_token"] = act }
    if let cid = conversationId { body["conversation_id"] = cid }
    guard !body.isEmpty else { return }

    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")
    if let data = try? JSONSerialization.data(withJSONObject: body, options: []) {
      req.httpBody = data
      URLSession.shared.dataTask(with: req).resume()
    }
  }

  @objc private func onDefaultsChanged() {
    guard let raw = UserDefaults.standard.string(forKey: "memento_live_activity_cmd"),
          !raw.isEmpty,
          let data = raw.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
      return
    }
    let ts = (json["ts"] as? Double) ?? 0
    if ts > 0 && ts <= lastHandledCmdTs {
      return
    }
    lastHandledCmdTs = ts
    handleCommand(json)
  }

  public func handleCommand(_ json: [String: Any]) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    guard let action = json["action"] as? String,
          let convId = json["conversationId"] as? String,
          !convId.isEmpty else {
      return
    }

    let title = (json["title"] as? String) ?? "后台任务"
    let engine = (json["engine"] as? String) ?? "AI"
    let deviceName = (json["deviceName"] as? String) ?? "云端"
    let status = (json["status"] as? String) ?? "running"
    let currentStep = (json["currentStep"] as? String) ?? "正在执行..."
    let stepCount = (json["stepCount"] as? Int) ?? 1
    let toolName = json["toolName"] as? String
    let startedAt = (json["startedAtEpoch"] as? Double) ?? Date().timeIntervalSince1970
    let elapsed = max(0, Int(Date().timeIntervalSince1970 - startedAt))

    let state = MementoTaskAttributes.ContentState(
      status: status,
      currentStep: currentStep,
      stepCount: stepCount,
      toolName: toolName,
      elapsedSeconds: elapsed
    )

    Task {
      let existing = Activity<MementoTaskAttributes>.activities.first(where: { $0.attributes.conversationId == convId })

      if action == "end" {
        if let act = existing {
          let content = ActivityContent(state: state, staleDate: nil)
          await act.end(content, dismissalPolicy: .after(Date().addingTimeInterval(60)))
        }
        return
      }

      if let act = existing {
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(900))
        await act.update(content)
        self.observeActivityPushToken(act)
      } else if action == "start" || action == "update" {
        for other in Activity<MementoTaskAttributes>.activities where other.attributes.conversationId != convId {
          if other.content.state.status == "done" || other.content.state.status == "error" {
            await other.end(nil, dismissalPolicy: .immediate)
          }
        }
        let attrs = MementoTaskAttributes(
          conversationId: convId,
          title: title,
          engine: engine,
          deviceName: deviceName,
          startedAtEpoch: startedAt
        )
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(900))
        do {
          let newAct = try Activity<MementoTaskAttributes>.request(
            attributes: attrs,
            content: content,
            pushType: .token
          )
          self.observeActivityPushToken(newAct)
        } catch {}
      }
    }
  }

  @objc public func syncWithActiveServerRuns() {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let defaults = UserDefaults.standard
    guard let server = defaults.string(forKey: "memento_server"),
          let token = defaults.string(forKey: "memento_token"),
          !server.isEmpty, !token.isEmpty else {
      return
    }
    let cleanServer = server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let url = URL(string: "\\(cleanServer)/api/ask/runs/active") else { return }

    var req = URLRequest(url: url)
    req.httpMethod = "GET"
    req.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")

    URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
      guard let self = self,
            let data = data,
            let root = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any],
            let runs = root["runs"] as? [[String: Any]] else {
        return
      }

      var activeConvIds = Set<String>()
      for r in runs {
        guard let cid = r["conversation_id"] as? String, !cid.isEmpty else { continue }
        let isDone = (r["done"] as? Bool) ?? false
        let isFailed = (r["failed"] as? Bool) ?? false
        let isCancelled = (r["cancelled"] as? Bool) ?? false
        if !isDone && !isFailed && !isCancelled {
          activeConvIds.insert(cid)
          let mode = ((r["execution_mode"] as? String) ?? "").lowercased()
          let eng = mode.contains("claude") ? "Claude" : mode.contains("agy") || mode.contains("antigravity") ? "AGY" : mode.contains("codex") ? "Codex" : "AI"
          self.handleCommand([
            "action": "start",
            "conversationId": cid,
            "title": (r["title"] as? String) ?? "后台任务",
            "engine": eng,
            "deviceName": (r["device_name"] as? String) ?? "云端",
            "status": (r["step_type"] as? String) ?? "running",
            "currentStep": (r["current_step"] as? String) ?? "正在执行...",
            "stepCount": (r["step_count"] as? Int) ?? 1,
            "toolName": r["tool_name"] as Any,
            "startedAtEpoch": (r["started_at"] as? Double) ?? Date().timeIntervalSince1970
          ])
        }
      }

      Task {
        for act in Activity<MementoTaskAttributes>.activities {
          if !activeConvIds.contains(act.attributes.conversationId) && act.content.state.status != "done" {
            let finalState = MementoTaskAttributes.ContentState(
              status: "done",
              currentStep: "任务完成",
              stepCount: act.content.state.stepCount,
              toolName: nil,
              elapsedSeconds: max(1, Int(Date().timeIntervalSince1970 - act.attributes.startedAtEpoch))
            )
            let content = ActivityContent(state: finalState, staleDate: nil)
            await act.end(content, dismissalPolicy: .after(Date().addingTimeInterval(30)))
          }
        }
      }
    }.resume()
  }
}
`;

function modifyAppDelegate(contents) {
  if (contents.includes("MementoLiveActivityManager")) {
    return contents;
  }

  let newContents = contents;
  if (!newContents.includes("import ActivityKit")) {
    newContents = newContents.replace("import React", "import React\nimport ActivityKit");
  }

  if (newContents.includes("@main\nclass AppDelegate")) {
    newContents = newContents.replace("@main\nclass AppDelegate", `${MANAGER_CODE}\n@main\nclass AppDelegate`);
  } else if (newContents.includes("class AppDelegate")) {
    newContents = newContents.replace("class AppDelegate", `${MANAGER_CODE}\nclass AppDelegate`);
  }

  if (!newContents.includes("MementoLiveActivityManager.shared")) {
    newContents = newContents.replace(
      "return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
      `if #available(iOS 16.2, *) {\n      _ = MementoLiveActivityManager.shared\n    }\n    return super.application(application, didFinishLaunchingWithOptions: launchOptions)`
    );
  }

  return newContents;
}

function withLiveActivityPlugin(config) {
  config = withInfoPlist(config, (config) => {
    config.modResults.NSSupportsLiveActivities = true;
    config.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    return config;
  });

  config = withAppDelegate(config, (config) => {
    config.modResults.contents = modifyAppDelegate(config.modResults.contents);
    return config;
  });

  config = withDangerousMod(config, [
    "ios",
    async (config) => {
      const iosRoot = config.modRequest.platformProjectRoot;
      const widgetDir = path.join(iosRoot, "MementoLiveActivity");
      fs.mkdirSync(widgetDir, { recursive: true });
      fs.writeFileSync(path.join(widgetDir, "MementoTaskAttributes.swift"), ATTRIBUTES_SWIFT, "utf8");
      fs.writeFileSync(path.join(widgetDir, "MementoLiveActivity.swift"), WIDGET_SWIFT, "utf8");
      fs.writeFileSync(path.join(widgetDir, "Info.plist"), WIDGET_PLIST, "utf8");
      return config;
    },
  ]);

  return config;
}

module.exports = createRunOncePlugin(withLiveActivityPlugin, PKG_NAME, PKG_VERSION);
