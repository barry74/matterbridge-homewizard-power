/**
 * HomeWizard local API client (v1 and v2).
 * Docs: https://api-documentation.homewizard.com/
 */

import http from 'node:http';
import https from 'node:https';

export interface HomeWizardDeviceConfig {
  name: string;
  host: string;
  api?: 'v1' | 'v2';
  token?: string;
  serial?: string;
}

export interface HomeWizardExternal {
  unique_id?: string;
  type?: string;
  value?: number;
  unit?: string;
  timestamp?: string;
}

/** Normalised measurement. Power is signed: negative means export. */
export interface HomeWizardReading {
  productType: string;
  productName: string;
  serial: string;
  firmware: string;
  powerW: number | null;
  powerL1W: number | null;
  powerL2W: number | null;
  powerL3W: number | null;
  voltageV: number | null;
  currentA: number | null;
  frequencyHz: number | null;
  importKwh: number | null;
  exportKwh: number | null;
  gasM3: number | null;
  stateOfChargePct: number | null;
}

interface BasicInfo {
  product_type?: string;
  product_name?: string;
  serial?: string;
  firmware_version?: string;
  api_version?: string;
}

type Raw = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumTariffs(raw: Raw, prefix: string): number | null {
  const direct = num(raw[prefix]);
  if (direct !== null) return direct;
  let total = 0;
  let found = false;
  for (let i = 1; i <= 4; i++) {
    const part = num(raw[`${prefix.replace(/_kwh$/, '')}_t${i}_kwh`]) ?? num(raw[`${prefix}_t${i}`]);
    if (part !== null) {
      total += part;
      found = true;
    }
  }
  // v1 names: total_power_import_t1_kwh
  if (!found) {
    const v1Prefix = prefix.startsWith('energy_') ? prefix.replace('energy_', 'total_power_') : prefix;
    for (let i = 1; i <= 4; i++) {
      const part = num(raw[`${v1Prefix.replace(/_kwh$/, '')}_t${i}_kwh`]);
      if (part !== null) {
        total += part;
        found = true;
      }
    }
  }
  return found ? total : null;
}

function gasFrom(raw: Raw): number | null {
  const direct = num(raw.total_gas_m3);
  if (direct !== null) return direct;
  const external = raw.external;
  if (!Array.isArray(external)) return null;
  const gas = (external as HomeWizardExternal[]).find((item) => item.type === 'gas_meter' && item.unit === 'm3');
  return gas ? num(gas.value) : null;
}

export function normalise(basic: BasicInfo, raw: Raw): HomeWizardReading {
  const importKwh =
    num(raw.energy_import_kwh) ??
    num(raw.total_power_import_kwh) ??
    sumTariffs(raw, 'energy_import_kwh') ??
    sumTariffs(raw, 'total_power_import_kwh');
  const exportKwh =
    num(raw.energy_export_kwh) ??
    num(raw.total_power_export_kwh) ??
    sumTariffs(raw, 'energy_export_kwh') ??
    sumTariffs(raw, 'total_power_export_kwh');

  return {
    productType: basic.product_type ?? 'HWE',
    productName: basic.product_name ?? basic.product_type ?? 'HomeWizard',
    serial: basic.serial ?? 'homewizard',
    firmware: basic.firmware_version ?? '0',
    powerW: num(raw.power_w) ?? num(raw.active_power_w),
    powerL1W: num(raw.power_l1_w) ?? num(raw.active_power_l1_w),
    powerL2W: num(raw.power_l2_w) ?? num(raw.active_power_l2_w),
    powerL3W: num(raw.power_l3_w) ?? num(raw.active_power_l3_w),
    voltageV: num(raw.voltage_v) ?? num(raw.voltage_l1_v) ?? num(raw.active_voltage_v) ?? num(raw.active_voltage_l1_v),
    currentA: num(raw.current_a) ?? num(raw.active_current_a) ?? num(raw.active_current_l1_a),
    frequencyHz: num(raw.frequency_hz) ?? 50,
    importKwh,
    exportKwh,
    gasM3: gasFrom(raw),
    stateOfChargePct: num(raw.state_of_charge_pct),
  };
}

function requestJson(url: string, headers: Record<string, string>, insecure: boolean): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers, rejectUnauthorized: !insecure, timeout: 8000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 180)}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as Raw);
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${(error as Error).message}`));
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`Timeout talking to ${url}`));
    });
    req.on('error', reject);
  });
}

export async function readHomeWizard(device: HomeWizardDeviceConfig): Promise<HomeWizardReading> {
  const host = device.host.replace(/\/$/, '');
  const api = device.api ?? 'v1';
  if (api === 'v2') {
    if (!device.token) throw new Error(`${device.name}: v2 requires a bearer token`);
    const headers = {
      Authorization: `Bearer ${device.token}`,
      'X-Api-Version': '2',
      Accept: 'application/json',
    };
    const basic = (await requestJson(`https://${host}/api`, headers, true)) as BasicInfo;
    const measurement = await requestJson(`https://${host}/api/measurement`, headers, true);
    return normalise(basic, measurement);
  }
  const basic = (await requestJson(`http://${host}/api`, { Accept: 'application/json' }, false)) as BasicInfo;
  const measurement = await requestJson(`http://${host}/api/v1/data`, { Accept: 'application/json' }, false);
  return normalise(basic, measurement);
}

/** kWh -> milliwatt-hours, the Matter Electrical Energy Measurement unit. */
export function kwhToMwh(kwh: number): bigint {
  return BigInt(Math.round(kwh * 1_000_000));
}

/** Watts -> milliwatts. */
export function wToMw(watts: number): bigint {
  return BigInt(Math.round(watts * 1000));
}
