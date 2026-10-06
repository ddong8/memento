export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Plain-language message for a failed call. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) {
      if (e.message && e.message.includes("Invalid credentials")) return "账号或密码错误，请检查后再试";
      return "登录已过期或凭证无效，请重新登录";
    }
    if (e.status === 404) return "服务端版本太旧，没有这个功能";
    if (e.status >= 500) return `服务端出错（${e.status}），稍后再试`;
    return e.message;
  }
  if (e instanceof TypeError) return "连不上服务端，检查网络后再试";
  return e instanceof Error ? e.message : String(e);
}
