import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { HRUPlatform } from './platform';
import ModbusRTU from 'modbus-serial';

export class HRUAccessory {
  private service: Service;
  private client: ModbusRTU;
  private isConnected: boolean = false;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private readonly DISCONNECT_TIMEOUT = 60000; // 60 seconds
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  private readonly OPERATION_TIMEOUT = 5000; // 5 seconds for operations
  private operationInProgress: boolean = false;

  constructor(
    private readonly platform: HRUPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.client = new ModbusRTU();

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
      .on('set', this.handleOnSetSpeed.bind(this))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1
      });
  }

  private async connectModbusClient(): Promise<void> {
    if (this.isConnected) {
      this.resetDisconnectTimeout();
      return;
    }

    try {
      this.platform.log.debug(`Attempting to connect to Modbus device at ${this.platform.ip}:${this.platform.port}`);
      await Promise.race([
        this.client.connectTCP(this.platform.ip, { port: this.platform.port }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), this.OPERATION_TIMEOUT))
      ]);
      this.isConnected = true;
      this.platform.log.info(`Successfully connected to Modbus device at ${this.platform.ip}:${this.platform.port}`);
      this.resetDisconnectTimeout();
    } catch (error) {
      this.isConnected = false;
      this.platform.log.error(`Failed to connect to Modbus device: ${error}`);
      throw error;
    }
  }

  private resetDisconnectTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    
    this.connectionTimeout = setTimeout(async () => {
      await this.disconnect();
    }, this.DISCONNECT_TIMEOUT);
  }

  private async disconnect(): Promise<void> {
    if (this.isConnected) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.client.close((error: Error | null) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          });
        });
        this.isConnected = false;
        this.platform.log.debug('Disconnected from Modbus device due to inactivity');
      } catch (error) {
        this.platform.log.error('Error disconnecting from Modbus device:', error);
      } finally {
        this.isConnected = false;
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
      }
    }
  }

  private async ensureConnection() {
    if (this.operationInProgress) {
      throw new Error('Operation already in progress');
    }
    
    if (!this.isConnected) {
      await this.connectModbusClient();
    } else {
      this.resetDisconnectTimeout();
    }
  }

  private async executeWithTimeout<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationInProgress) {
      throw new Error('Operation already in progress');
    }

    this.operationInProgress = true;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<T>((_, reject) => 
          setTimeout(() => reject(new Error('Operation timeout')), this.OPERATION_TIMEOUT)
        )
      ]);
      return result;
    } finally {
      this.operationInProgress = false;
    }
  }

  handleOnGetOn(callback: CharacteristicGetCallback) {
    const operation = async () => {
      await this.ensureConnection();
      const response = await this.client.readHoldingRegisters(this.platform.regimeRegister, 1);
      const currentValue = response.data[0] === 0 ? 0 : 1;
      this.platform.log.debug('State is:', currentValue);
      return currentValue;
    };

    this.executeWithTimeout(operation)
      .then(value => callback(null, value))
      .catch(error => {
        this.platform.log.error('Error getting On state:', error);
        this.isConnected = false;
        callback(error);
      });
  }

  handleOnSetOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const operation = async () => {
      await this.ensureConnection();
      const setValue = (value as number) >= 1 ? 2 : 0;
      await this.client.writeRegister(this.platform.regimeRegister, setValue);
      this.platform.log.debug(`Set On state to: ${value}`);
    };

    this.executeWithTimeout(operation)
      .then(() => callback(null))
      .catch(error => {
        this.platform.log.error('Error setting On state:', error);
        this.isConnected = false;
        callback(error);
      });
  }

  handleOnGetSpeed(callback: CharacteristicGetCallback) {
    const operation = async () => {
      await this.ensureConnection();
      const response = await this.client.readHoldingRegisters(this.platform.speedRegister, 1);
      const currentValue = response.data[0];
      this.platform.log.debug('Speed is:', currentValue);
      return currentValue;
    };

    this.executeWithTimeout(operation)
      .then(value => callback(null, value))
      .catch(error => {
        this.platform.log.error('Error getting Speed:', error);
        this.isConnected = false;
        callback(error);
      });
  }

  handleOnSetSpeed(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    const operation = async () => {
      await this.ensureConnection();
      const response = await this.client.readHoldingRegisters(this.platform.regimeRegister, 1);
      const state = response.data[0];
      
      if (state === 0) {
        await this.client.writeRegister(this.platform.regimeRegister, 2);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      await this.client.writeRegister(this.platform.speedRegister, value as number);
      this.platform.log.debug(`Set Speed to: ${value}`);
    };

    this.executeWithTimeout(operation)
      .then(() => callback(null))
      .catch(error => {
        this.platform.log.error('Error setting Speed:', error);
        this.isConnected = false;
        callback(error);
      });
  }
}