// Audit log display: names of the audited actions and a one-line summary of an entry.

/** What each audited action is called in the list (server/services/audit_service.py records them). */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "auth.login": "密码登录",
  "auth.login_failed": "登录失败",
  "auth.github.login": "GitHub 登录",
  "auth.sso.login": "企业账号登录",
  "auth.sso.denied": "企业账号登录被拒",
  "admin.user.approve": "批准账号",
  "admin.user.update": "修改角色或状态",
  "admin.user.rotate_token": "重置采集令牌",
  "admin.user.delete": "删除账号",
  "admin.owner.transfer": "转让所有者",
  "admin.invite.create": "创建邀请码",
  "admin.invite.revoke": "作废邀请码",
  "admin.permission.grant": "授予权限",
  "admin.permission.revoke": "收回权限",
  "device_task.dispatch": "向设备派发命令",
  "device.access_other_user": "访问他人设备",
  "llm_settings.update": "修改模型配置",
  "scim.user.create": "身份平台开通账号",
  "scim.user.activate": "身份平台启用账号",
  "scim.user.deactivate": "身份平台停用账号",
};

/** One line on what happened: who it was done to and the particulars worth reading. */
export function auditSummary(meta: Record<string, unknown> | undefined): string {
  if (!meta) return "";
  const parts: string[] = [];
  const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
  if (meta.email) parts.push(s(meta.email));
  if (meta.device) parts.push(`设备 ${s(meta.device)}`);
  if (meta.before && meta.after) {
    const b = meta.before as Record<string, unknown>;
    const a = meta.after as Record<string, unknown>;
    for (const k of ["role", "status"]) if (b[k] !== a[k]) parts.push(`${s(b[k])} → ${s(a[k])}`);
  }
  if (meta.preview) parts.push(s(meta.preview).slice(0, 120));
  if (meta.reason) parts.push(s(meta.reason));
  if (meta.base_url) parts.push(s(meta.base_url));
  if (meta.other_users_device) parts.push("他人的设备");
  return parts.filter(Boolean).join(" · ");
}
