import type { AlertState } from './types.js';

const alertStates = new Map<string, AlertState>();

export function getAlertState(checkName: string): AlertState {
  const state = alertStates.get(checkName);
  if (!state) {
    return { lastAlertTime: 0, wasHealthy: true };
  }
  return state;
}

export function setAlertState(checkName: string, state: AlertState): void {
  alertStates.set(checkName, state);
}

export function shouldSendAlert(
  checkName: string,
  isHealthy: boolean,
  cooldownMs: number
): { shouldSend: boolean; isRecovery: boolean } {
  const state = getAlertState(checkName);
  const now = Date.now();

  // State changed from healthy to unhealthy - always alert
  if (state.wasHealthy && !isHealthy) {
    return { shouldSend: true, isRecovery: false };
  }

  // State changed from unhealthy to healthy - send recovery
  if (!state.wasHealthy && isHealthy) {
    return { shouldSend: true, isRecovery: true };
  }

  // Still unhealthy - check cooldown
  if (!isHealthy && (now - state.lastAlertTime) >= cooldownMs) {
    return { shouldSend: true, isRecovery: false };
  }

  return { shouldSend: false, isRecovery: false };
}

export function updateAlertState(checkName: string, isHealthy: boolean): void {
  setAlertState(checkName, {
    lastAlertTime: Date.now(),
    wasHealthy: isHealthy,
  });
}
