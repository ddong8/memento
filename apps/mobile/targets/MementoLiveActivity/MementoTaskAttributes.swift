import ActivityKit
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
