import ActivityKit
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
          Text("Memento · \(context.attributes.engine)")
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
          HStack(spacing: 6) {
            Text(timerInterval: startDate...endDate, countsDown: false)
              .monospacedDigit()
              .font(.system(size: 12, weight: .bold, design: .monospaced))
              .foregroundColor(.white)
              .frame(width: 44, alignment: .trailing)

            Link(destination: URL(string: "memento:///?action=cancel&id=\(context.attributes.conversationId)")!) {
              HStack(spacing: 2) {
                Image(systemName: "stop.fill")
                  .font(.system(size: 7, weight: .bold))
                Text("停止")
                  .font(.system(size: 10, weight: .semibold))
              }
              .foregroundColor(Color(red: 0.98, green: 0.35, blue: 0.45))
              .padding(.horizontal, 6)
              .padding(.vertical, 3)
              .background(Color(red: 0.98, green: 0.35, blue: 0.45).opacity(0.18))
              .clipShape(Capsule())
            }
          }
        } else {
          Text("\(context.state.elapsedSeconds)s")
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

        Text("步骤 #\(max(1, context.state.stepCount))")
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
        .widgetURL(URL(string: "memento:///?target=%2Fask%3Fid%3D\(context.attributes.conversationId)%26scroll%3Dbottom"))
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
            Text("· \(context.attributes.deviceName)")
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
              HStack(spacing: 5) {
                Text(timerInterval: startDate...endDate, countsDown: false)
                  .monospacedDigit()
                  .font(.system(size: 12, weight: .bold, design: .monospaced))
                  .foregroundColor(.white)
                  .frame(width: 42, alignment: .trailing)

                Link(destination: URL(string: "memento:///?action=cancel&id=\(context.attributes.conversationId)")!) {
                  Image(systemName: "stop.circle.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(Color(red: 0.98, green: 0.35, blue: 0.45))
                }
              }
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

              Text("#\(max(1, context.state.stepCount))")
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
      .widgetURL(URL(string: "memento:///?target=%2Fask%3Fid%3D\(context.attributes.conversationId)%26scroll%3Dbottom"))
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
