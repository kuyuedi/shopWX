export type AlertLevel = 'info' | 'warning' | 'critical';

export interface Alert {
  level: AlertLevel;
  title: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CheckResult {
  name: string;
  healthy: boolean;
  level?: AlertLevel;
  message: string;
  details?: Record<string, unknown>;
}

export interface AlertState {
  lastAlertTime: number;
  wasHealthy: boolean;
}

export interface Config {
  telegramBotToken: string;
  telegramChatId: string;
  intervalMs: number;
  diskWarningThreshold: number;
  diskCriticalThreshold: number;
  dataFlowMinRecords: number;
  dataFlowCheckMinutes: number;
  alertCooldownMs: number;
  serverIp: string;
}
