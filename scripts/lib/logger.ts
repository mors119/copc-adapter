export function info(message: string) {
  console.log(`[INFO] ${message}`);
}

export function success(message: string) {
  console.log(`[SUCCESS] ${message}`);
}

export function warning(message: string) {
  console.warn(`[WARNING] ${message}`);
}

export function error(message: string) {
  console.error(`[ERROR] ${message}`);
}
