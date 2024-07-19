import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
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
    this.connectModbusClient();

    this.service = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGetOn.bind(this))
      .onSet(this.handleOnSetOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.handleOnGetSpeed.bind(this))
      .onSet(this.handleOnSetSpeed.bind(this));
  }

  private async connectModbusClient() {
    try {
      await this.client.connectTCP(this.platform.ip, { port: this.platform.port });
      this.isConnected = true;
      this.platform.log.info(`Connected to Modbus device at ${this.platform.ip}:${this.platform.port}`);
    } catch (error) {
      this.isConnected = false;
      if (error instanceof Error) {
        this.platform.log.error(`Error connecting to Modbus device: ${error.message}`);
      } else {
        this.platform.log.error('An unknown error connecting to Modbus device.');
      }
      setTimeout(() => this.connectModbusClient(), 5000); // Try to reconnect after 5 seconds
    }
  }

  private async ensureConnection() {
    if (!this.isConnected) {
      await this.connectModbusClient();
    }
  }

  async handleOnGetOn(): Promise<CharacteristicValue> {
    try {
      await this.ensureConnection();
      const response = await this.client.readInputRegisters(this.platform.regimeRegister, 1);
      let currentValue = response.data[0];
      currentValue = currentValue >= 2 ? 1 : currentValue;
      this.platform.log.debug('State is:', currentValue);
      return currentValue;
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error getting On state: ${error.message}`);
      } else {
        this.platform.log.error('An unknown error occurred while getting On state');
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async handleOnSetOn(value: CharacteristicValue) {
    try {
      await this.ensureConnection();
      let setValue = value as number;
      if (setValue >= 1) {
        setValue = 2;
      }
      await this.client.writeRegisters(this.platform.regimeRegister, [setValue]);
      this.platform.log.debug(`Set On state to: ${setValue}`);
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error setting On state: ${error.message}`);
      } else {
        this.platform.log.error('An unknown error occurred while setting On state');
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async handleOnGetSpeed(): Promise<CharacteristicValue> {
    try {
      await this.ensureConnection();
      const response = await this.client.readInputRegisters(this.platform.speedRegister, 1);
      const currentValue = response.data[0];
      this.platform.log.debug('Speed is:', currentValue);
      return currentValue;
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error getting speed state: ${error.message}`);
      } else {
        this.platform.log.error('An unknown error occurred while getting speed state');
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async handleOnSetSpeed(value: CharacteristicValue) {
    try {
      await this.ensureConnection();
      const response = await this.client.readInputRegisters(this.platform.regimeRegister, 1);
      const state = response.data[0];
      if (state === 0) {
        await this.handleOnSetOn(1);
        await this.delay(5000);
      }
      await this.client.writeRegisters(this.platform.speedRegister, [value as number]);
      this.platform.log.debug(`Set Speed to: ${value}`);
    } catch (error) {
      if (error instanceof Error) {
        this.platform.log.error(`Error setting speed state: ${error.message}`);
      } else {
        this.platform.log.error('An unknown error occurred while setting speed state');
      }
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}