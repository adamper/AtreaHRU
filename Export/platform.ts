import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HRUAccessory } from './platformAccessory';

export class HRUPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly hruAccessories: HRUAccessory[] = [];

  public ip: string;
  public port: number;
  public regimeRegister: number;
  public speedRegister: number;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    // Nejdříve přiřadíme Service a Characteristic
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;
    this.ip = config.ip || '192.168.0.20';
    this.port = config.port || 502;
    this.regimeRegister = config.regimeRegister || 1001;
    this.speedRegister = config.speedRegister || 1000;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.discoverDevices();
    });

    // Cleanup při ukončení
    this.api.on('shutdown', () => {
      this.log.debug('Platform shutdown initiated');
      this.cleanup();
    });

    // Backup cleanup pro případ, že shutdown event nebude volán
    process.on('SIGTERM', this.cleanup.bind(this));
    process.on('SIGINT', this.cleanup.bind(this));
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  discoverDevices() {
    const uuid = this.api.hap.uuid.generate('homebridge-hru-001');
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
      const hruAccessory = new HRUAccessory(this, existingAccessory);
      this.hruAccessories.push(hruAccessory);
    } else {
      this.log.info('Adding new accessory');
      const accessory = new this.api.platformAccessory('HRU Device', uuid);
      const hruAccessory = new HRUAccessory(this, accessory);
      this.hruAccessories.push(hruAccessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  private cleanup(): void {
    this.log.debug('Cleaning up platform...');
    
    // Odpojíme všechny HRU accessory
    this.hruAccessories.forEach(accessory => {
      try {
        accessory.disconnect();
      } catch (error) {
        this.log.debug('Error disconnecting accessory:', error);
      }
    });
    
    this.hruAccessories.length = 0;
  }
}