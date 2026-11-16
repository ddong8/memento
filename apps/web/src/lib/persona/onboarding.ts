/**
 * 个人画像页的形象引导与舞台默认值（用户规则：首次进入引导设置性别和卡通形象，可上传照片生成，
 * 默认全屏动画；11-16 起默认 3D，和长期记忆、技能进化两个 3D 页面一致，原来的「3D 默认不选中」作废）。抽成纯函数是为了让业务蓝图 R-PERSONA-ONBOARD 有测试守着。
 */

/** 进入画像页时舞台的默认状态：右侧面板收起（全屏动画），默认 3D 形象（2D 卡通可手动切换）。 */
export const PERSONA_STAGE_DEFAULTS = Object.freeze({
  panelCollapsed: true,
  threeD: true,
});

export interface AvatarOnboardingState {
  /** 服务端是否已保存过这个用户的形象 */
  initialized: boolean;
  /** 本机是否已跳过或完成过引导 */
  dismissed: boolean;
  /** 这次打开页面是否已经判断过（只弹一次） */
  checked: boolean;
}

/** 首次进入（服务端没有形象、本机没跳过、本次还没弹过）才弹形象引导。 */
export function shouldOfferAvatarOnboarding(s: AvatarOnboardingState): boolean {
  return !s.initialized && !s.dismissed && !s.checked;
}

/** 本机已跳过但服务端还没有形象：把默认形象悄悄存回服务端，其他设备也不再弹。 */
export function shouldBackfillDefaultAvatar(s: AvatarOnboardingState): boolean {
  return !s.initialized && s.dismissed;
}
