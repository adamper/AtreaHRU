import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { HRUPlatform } from './platform';
import ModbusRTU from 'modbus-serial';

export class HRUAccessory {
  private service: Service;
  private client: ModbusRTU;
  private isConnected: boolean = false;

  constructor(
    private readonly platform: HRUPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.client = new ModbusRTU();
    this.connectModbusClient().catch(error => {
      this.platform.log.error('Failed to establish initial Modbus connection:', error);
    });

    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'HRU Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'HRU Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'HRU Serial Number');

    this.service = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);

    this.service.setCharacteristic(this.platform.Characteristic.Name, 'HRU Fan');

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .on('get', this.handleOnGetOn.bind(this))
      .on('set', this.handleOnSetOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .on('get', this.handleOnGetSpeed.bind(this))
      .on('set', this.handleOnSetSpeed.bind(this));
  }

  private async connectModbusClient(): Promise<void> {
    try {
      this.platform.log.debug(`Attempting to connect to Modbus device at ${this.platform.ip}:${this.platform.port}`);
      await this.client.connectTCP(this.platform.ip, { port: this.platform.port, timeout: 10000 });
      this.isConnected = true;
      this.platform.log.info(`Successfully connected to Modbus device at ${this.platform.ip}:${this.platform.port}`);
    } catch (error) {
      this.isConnected = false;
      if (error instanceof Error) {
        this.platform.log.error(`Failed to connect to Modbus device: ${error.message}`);
      } else {
        this.platform.log.error('Failed to connect to Modbus device with an unknown error');
      }
      throw error;
    }
  }

  private async ensureConnection() {
    if (!this.isConnected) {
      await this.connectModbusClient();
    }
  }

  handleOnGetOn(callback: CharacteristicGetCallback) {
    this.ensureConnection()
      .then(() => this.client.readHoldingRegisters(this.platform.regimeRegister, 1))
      .then(response => {
        const currentValue = response.data[0] === 0 ? 0 : 1;
        this.platform.log.debug('State is:', currentValue);
        callback(null, currentValue);
      })
      .catch(error => {
        this.platform.log.error('Error getting On state:', error);
        callback(error);
      });
  }

  handleOnSetOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.ensureConnection()
      .then(() => {
        const setValue = (value as number) >= 1 ? 2 : 0;
        return this.client.writeRegister(this.platform.regimeRegister, setValue);
      })
      .then(() => {
        this.platform.log.debug(`Set On state to: ${value}`);
        callback(null);
      })
      .catch(error => {
        this.platform.log.error('Error setting On state:', error);
        callback(error);
      });
  }

  handleOnGetSpeed(callback: CharacteristicGetCallback) {
    this.ensureConnection()
      .then(() => this.client.readHoldingRegisters(this.platform.speedRegister, 1))
      .then(response => {
        const currentValue = response.data[0];
        this.platform.log.debug('Speed is:', currentValue);
        callback(null, currentValue);
      })
      .catch(error => {
        this.platform.log.error('Error getting Speed:', error);
        callback(error);
      });
  }

  handleOnSetSpeed(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.ensureConnection()
      .then(() => this.client.readHoldingRegisters(this.platform.regimeRegister, 1))
      .then(response => {
        const state = response.data[0];
        if (state === 0) {
          return this.client.writeRegister(this.platform.regimeRegister, 2)
            .then(() => new Promise(resolve => setTimeout(resolve, 5000)));
        }
        return Promise.resolve();
      })
      .then(() => this.client.writeRegister(this.platform.speedRegister, value as number))
      .then(() => {
        this.platform.log.debug(`Set Speed to: ${value}`);
        callback(null);
      })
      .catch(error => {
        this.platform.log.error('Error setting Speed:', error);
        callback(error);
      });
  }
}