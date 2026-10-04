/**
 * Классификация транзиентных сбоев внешних вызовов (git, HTTP API).
 *
 * Транзиентный сбой повторяется с backoff — как вызовы storage в legacy §3.7. Финальный
 * отказ (авторизация, «не найдено», отказ прав) повторять нельзя: повтор не поможет, а
 * только задержит честную ошибку и смажет её причину.
 *
 * Порядок проверок важен: сообщение про 403 содержит «unable to access», и без явной
 * проверки финальных паттернов любой отказ прав выглядел бы как сбой сети.
 */

const TRANSIENT =
  /connection reset|early EOF|timed out|timeout|could not resolve|unable to access|remote end hung up|RPC failed|unexpected disconnect|network is unreachable|SSL_ERROR|50[234] |502 Bad Gateway|503 Service|504 Gateway|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

const FINAL =
  /authentication failed|401|403|permission .* denied|repository not found|not found|does not appear to be a git repository|could not read from remote repository|terminal prompts disabled/i;

export function isTransientFailure(stderr: string, timedOut: boolean): boolean {
  if (timedOut) return true;
  if (FINAL.test(stderr)) return false;
  return TRANSIENT.test(stderr);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Задержки между попытками: 250 мс, 750 мс, 2 с. */
export const RETRY_DELAYS_MS = [250, 750, 2000];
