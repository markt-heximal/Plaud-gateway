/** One JSON line per event on stdout; never log tokens or transcript text. */
function emit(level: string, msg: string, fields?: Record<string, unknown>) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }));
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
