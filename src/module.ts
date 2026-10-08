/**
 * Matterbridge HomeWizard power plugin.
 *
 * Exposes HomeWizard P1 / kWh meter / Energy Socket / Plug-In Battery measurements
 * as a Matter Electrical Sensor (device type 0x0510) with:
 *   - Electrical Power Measurement (active power, voltage, current)
 *   - Electrical Energy Measurement (cumulative import and export)
 *   - Power Topology
 *
 * Apple Home does not let a bridge call EnergyKit. EnergyKit is an iOS framework
 * with a special entitlement for HVAC and EV apps. Controllers that implement
 * Matter 1.3 energy clusters (Apple Home on recent iOS, Home Assistant, SmartThings)
 * read these clusters. Use exposeAs "outlet" if your Home app only shows energy
 * on plug-in units.
 */

import {
  type BasePlatformConfig,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  bridgedNode,
  electricalSensor,
  onOffPlugInUnit,
  powerSource,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { ElectricalEnergyMeasurement, ElectricalPowerMeasurement, OnOff } from 'matterbridge/matter/clusters';
import { kwhToMwh, readHomeWizard, type HomeWizardDeviceConfig, type HomeWizardReading, wToMw } from './homewizard.js';

export type HomeWizardPlatformConfig = BasePlatformConfig & {
  whiteList?: string[];
  blackList?: string[];
  host?: string;
  deviceName?: string;
  api?: 'v1' | 'v2';
  token?: string;
  pollInterval?: number;
  exposeAs?: 'sensor' | 'outlet';
  devices?: HomeWizardDeviceConfig[];
};

interface PublishedDevice {
  config: HomeWizardDeviceConfig;
  endpoint: MatterbridgeEndpoint;
  serial: string;
}

export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: HomeWizardPlatformConfig): HomeWizardPowerPlatform {
  return new HomeWizardPowerPlatform(matterbridge, log, config);
}

export class HomeWizardPowerPlatform extends MatterbridgeDynamicPlatform {
  private published: PublishedDevice[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: HomeWizardPlatformConfig) {
    super(matterbridge, log, config);
    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.3.0')) {
      throw new Error(`This plugin requires Matterbridge >= 3.3.0 (found ${this.matterbridge.matterbridgeVersion}).`);
    }
    this.log.info(`Initializing ${this.config.name}...`);
  }

  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting ${this.config.name}: ${reason ?? 'no reason'}`);
    await this.ready;
    await this.clearSelect();

    const devices = this.configuredDevices();
    if (devices.length === 0) {
      this.log.error('Geen IP ingevuld. Open de pluginconfiguratie en vul het IP-adres van de meter in.');
      return;
    }

    for (const device of devices) {
      try {
        const reading = await readHomeWizard(device);
        const serial = device.serial?.trim() || reading.serial || device.host;
        const label = device.name || reading.productName;
        this.setSelectDevice(serial, label);
        if (!this.validateDevice([label, serial, device.host])) {
          this.log.info(`Skipping ${label} (${serial}) because of white/black list`);
          continue;
        }
        const endpoint = await this.createEndpoint(device, reading, serial, label);
        await this.registerDevice(endpoint);
        this.published.push({ config: device, endpoint, serial });
        this.log.info(`Registered ${label} serial ${serial} (${reading.productType})`);
      } catch (error) {
        this.log.error(`Failed to add ${device.name} @ ${device.host}: ${(error as Error).message}`);
      }
    }
  }

  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    await this.poll();
    const seconds = Math.max(1, this.config.pollInterval ?? 5);
    this.timer = setInterval(() => {
      void this.poll();
    }, seconds * 1000);
    this.log.info(`Polling HomeWizard every ${seconds}s`);
  }

  private configuredDevices(): HomeWizardDeviceConfig[] {
    const extra = (this.config.devices ?? []).filter((device) => device.host?.trim());
    const host = this.config.host?.trim();
    if (!host) return extra;
    const primary: HomeWizardDeviceConfig = {
      name: this.config.deviceName?.trim() || 'P1 Meter',
      host,
      api: this.config.api ?? 'v1',
      token: this.config.token ?? '',
    };
    return [primary, ...extra.filter((device) => device.host.trim() !== host)];
  }

  override async onShutdown(reason?: string): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await super.onShutdown(reason);
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  private async createEndpoint(device: HomeWizardDeviceConfig, reading: HomeWizardReading, serial: string, label: string): Promise<MatterbridgeEndpoint> {
    const types = this.config.exposeAs === 'outlet' ? [onOffPlugInUnit, electricalSensor, bridgedNode, powerSource] : [electricalSensor, bridgedNode, powerSource];
    const endpoint = new MatterbridgeEndpoint(types, { id: serial }, this.config.debug)
      .createDefaultIdentifyClusterServer()
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        label,
        serial,
        0xfff1,
        'HomeWizard',
        reading.productName || 'HomeWizard Energy',
        1,
        reading.firmware || '1.0.0',
        1,
        reading.productType,
      )
      .createDefaultPowerSourceWiredClusterServer()
      .createDefaultPowerTopologyClusterServer()
      .createDefaultElectricalEnergyMeasurementClusterServer(kwhToMwh(reading.importKwh ?? 0), kwhToMwh(reading.exportKwh ?? 0))
      .createDefaultElectricalPowerMeasurementClusterServer(
        reading.voltageV === null ? 230_000 : Math.round(reading.voltageV * 1000),
        reading.currentA === null ? 0 : Math.round(Math.abs(reading.currentA) * 1000),
        reading.powerW === null ? 0 : wToMw(reading.powerW),
        Math.round((reading.frequencyHz ?? 50) * 1000),
      )
      .addRequiredClusterServers();

    if (this.config.exposeAs === 'outlet') {
      endpoint.createDefaultOnOffClusterServer(true);
      endpoint.addCommandHandler('on', () => {
        endpoint.log.info('Virtual on: HomeWizard meters cannot be switched');
      });
      endpoint.addCommandHandler('off', () => {
        endpoint.log.info('Virtual off ignored: HomeWizard meters cannot be switched');
        void endpoint.setAttribute(OnOff, 'onOff', true, endpoint.log);
      });
    }
    return endpoint;
  }

  private async poll(): Promise<void> {
    for (const published of this.published) {
      try {
        const reading = await readHomeWizard(published.config);
        await this.apply(published.endpoint, reading);
      } catch (error) {
        this.log.warn(`${published.config.name}: ${(error as Error).message}`);
      }
    }
  }

  private async apply(endpoint: MatterbridgeEndpoint, reading: HomeWizardReading): Promise<void> {
    const power = reading.powerW ?? 0;
    const voltage = reading.voltageV === null ? null : Math.round(reading.voltageV * 1000);
    const current = reading.currentA === null ? null : Math.round(Math.abs(reading.currentA) * 1000);
    await endpoint.setAttribute(ElectricalPowerMeasurement.Cluster.id, 'activePower', wToMw(power), this.log);
    if (voltage !== null) await endpoint.setAttribute(ElectricalPowerMeasurement.Cluster.id, 'voltage', voltage, this.log);
    if (current !== null) await endpoint.setAttribute(ElectricalPowerMeasurement.Cluster.id, 'activeCurrent', current, this.log);

    if (reading.importKwh !== null) {
      await endpoint.setAttribute(
        ElectricalEnergyMeasurement.Cluster.id,
        'cumulativeEnergyImported',
        { energy: kwhToMwh(reading.importKwh) },
        this.log,
      );
    }
    if (reading.exportKwh !== null) {
      await endpoint.setAttribute(
        ElectricalEnergyMeasurement.Cluster.id,
        'cumulativeEnergyExported',
        { energy: kwhToMwh(reading.exportKwh) },
        this.log,
      );
    }

    const phases = [reading.powerL1W, reading.powerL2W, reading.powerL3W].filter((value): value is number => value !== null);
    const phaseText = phases.length > 0 ? ` L1/L2/L3 ${phases.map((value) => `${value}W`).join(' ')}` : '';
    const gas = reading.gasM3 === null ? '' : ` gas ${reading.gasM3} m3`;
    const soc = reading.stateOfChargePct === null ? '' : ` soc ${reading.stateOfChargePct}%`;
    this.log.info(
      `${endpoint.deviceName}: ${power} W, import ${reading.importKwh ?? '-'} kWh, export ${reading.exportKwh ?? '-'} kWh${phaseText}${gas}${soc}`,
    );
  }
}
