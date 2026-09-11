export interface AuthStrategy {
  init(): Promise<void>;
  getHeaders(): Record<string, string>;
  destroy(): void;
}

export class CookieAuth implements AuthStrategy {
  async init(): Promise<void> {}

  getHeaders(): Record<string, string> {
    return {};
  }

  destroy(): void {}
}
