/**
 * scripts/cf-port/migrate/lib/transform-print-defaults.mjs — manifest row 69:
 * `settings/printRouting` → `print_defaults.default_printer_id` only (D52; no
 * garment routing table is built).
 *
 * D66: on staging the importer writes NULL (the imported `snapwear` is
 * inactive there; `print_defaults_platform_printer_*` triggers would still
 * accept an inactive platform printer as a default, but D66 chooses NULL
 * regardless, reported as an expected difference). On production it writes
 * the real default (verbatim `defaultPrinterUid`), provided that printer id
 * is `snapwear` — the only platform printer this importer ever creates.
 */

import { updateStatement } from './sql.mjs';
import { rowContentHash, carriedRow } from './plan.mjs';
import { SNAPWEAR_PRINTER_ID } from './transform-printers.mjs';
import { formatTime } from './time-columns.mjs';

export function transformPrintDefaults({ env, nowMillis, printRoutingDoc }) {
  const problems = [];
  const data = printRoutingDoc?.data ?? null;
  const updatedAt = formatTime('print_defaults', 'updated_at', nowMillis);

  if (env === 'staging') {
    const row = { default_printer_id: null, updated_at: updatedAt, updated_by: 'import' };
    const statement = updateStatement('print_defaults', row, { id: 1 });
    return {
      problems,
      report: { defaultPrinterId: null, reason: 'D66: staging always imports NULL (snapwear is inactive there)' },
      rows: [carriedRow('print_defaults', '1', statement, rowContentHash('print_defaults', ['id', ...Object.keys(row)], { id: 1, ...row }))],
    };
  }

  if (data === null) {
    problems.push('settings/printRouting is absent from the bundle — production default_printer_id left unset');
    return { problems, report: { defaultPrinterId: null }, rows: [] };
  }

  const defaultPrinterUid = data.defaultPrinterUid;
  if (defaultPrinterUid !== SNAPWEAR_PRINTER_ID) {
    problems.push(`settings/printRouting.defaultPrinterUid is ${JSON.stringify(defaultPrinterUid)}, not "${SNAPWEAR_PRINTER_ID}" — not imported (only snapwear is ever created as a platform printer, D12)`);
    return { problems, report: { defaultPrinterId: null }, rows: [] };
  }

  const row = { default_printer_id: defaultPrinterUid, updated_at: updatedAt, updated_by: 'import' };
  const statement = updateStatement('print_defaults', row, { id: 1 });
  return {
    problems,
    report: { defaultPrinterId: defaultPrinterUid },
    rows: [carriedRow('print_defaults', '1', statement, rowContentHash('print_defaults', ['id', ...Object.keys(row)], { id: 1, ...row }))],
  };
}
