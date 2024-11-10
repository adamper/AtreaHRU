import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { HRUPlatform } from './platform';
import ModbusRTU from 'modbus-serial';

export class HRUAccessory {
  private service: Service;
  private client: ModbusRTU;
  private isConnected: boolean = false;
  private connectionTimeout: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly DISCONNECT_TIMEOUT = 30000; // 30 seconds
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  private readonly OPERATION_TIMEOUT = 3000; // 3 seconds for operations
  private readonly MAX_RETRIES = 2;
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
      .on('get', this.createQuickResponseHandler(this.handleOnGetOn.bind(this)))
      .on('set', this.createQuickResponseHandler(this.handleOnSetOn.bind(this)));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .on('get', this.createQuickResponseHandler(this.handleOnGetSpeed.bind(this)))
      .on('set', this.createQuickResponseHandler(this.handleOnSetSpeed.bind(this)))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: 1
      });

    // Initial connection
    this.connectWithRetry();
  }

  private createQuickResponseHandler(handler: Function) {
    return (...args: any[]) => {
      const callback = args[args.length - 1];
      const startTime = Date.now();
      
      // Set a timeout to ensure we always respond
      const timeoutId = setTimeout(() => {
        this.platform.log.warn('Operation timed out, responding with cached or default value');
        if (handler.name.includes('Get')) {
          callback(null, 0); // Default value for gets
        } else {
          callback(null); // Default response for sets
        }
      }, this.OPERATION_TIMEOUT);

      // Call the actual handler
      handler(...args)
        .catch(error => {
          this.platform.log.error(`Handler error: ${error.message}`);
          return null;
        })
        .finally(() => {
          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;
          if (duration > 1000) {
            this.platform.log.warn(`Operation took ${duration}ms to complete`);
          }
        });
    };
  }

  private async connectWithRetry(retryCount = 0): Promise<void> {
    try {
      if (this.isConnected) {
        return;
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      await this.connectModbusClient();
    } catch (error) {
      this.platform.log.error(`Connection attempt ${retryCount + 1} failed:`, error);
      if (retryCount < this.MAX_RETRIES) {
        this.reconnectTimer = setTimeout(() => {
          this.connectWithRetry(retryCount + 1);
        }, this.RECONNECT_DELAY);
      }
    }
  }

  private async connectModbusClient(): Promise<void> {
    if (this.isConnected) {
      this.resetDisconnectTimeout();
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, this.OPERATION_TIMEOUT);

        this.client.connectTCP(this.platform.ip, { port: this.platform.port })
          .then(() => {
            clearTimeout(connectTimeout);
            resolve();
          })
          .catch(reject);
      });

      this.isConnected = true;
      this.platform.log.info(`Connected to Modbus device at ${this.platform.ip}:${this.platform.port}`);
      this.resetDisconnectTimeout();
    } catch (error) {
      this.isConnected = false;
      throw error;
    }
  }

  private resetDisconnectTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    
    this.connectionTimeout = setTimeout(() => {
      this.disconnect()
        .catch(error => this.platform.log.error('Error during disconnect:', error));
    }, this.DISCONNECT_TIMEOUT);
  }

  private async disconnect(): Promise<void> {
    if (!this.isConnected) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.client.close((error: Error | null) => {
        if (error) {
          this.platform.log.error('Error closing connection:', error);
        }
        this.isConnected = false;
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
          this.connectionTimeout = null;
        }
        resolve();
      });
    });
  }

  private async ensureConnection(): Promise<void> {
    if (!this.isConnected) {
      await this.connectWithRetry();
    } else {
      this.resetDisconnectTimeout();
    }
  }

  async handleOnGetOn(callback: CharacteristicGetCallback) {
    try {
      await this.ensureConnection();
      const response = await this.client.readHoldingRegisters(this.platform.regimeRegister, 1);
      const currentValue = response.data[0] === 0 ? 0 : 1;
      callback(null, currentValue);
    } catch (error) {
      this.platform.log.error('Error getting On state:', error);
      this.isConnected = false;
      callback(error);
    }
  }

  async handleOnSetOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    try {
      await this.ensureConnection();
      const setValue = (value as number) >= 1 ? 2 : 0;
      await this.client.writeRegister(this.platform.regimeRegister, setValue);
      callback(null);
    } catch (error) {
      this.platform.log.error('Error setting On state:', error);
      this.isConnected = false;
      callback(error);
    }
  }

  async handleOnGetSpeed(callback: CharacteristicGetCallback) {
    try {
      await this.ensureConnection();
      const response = await this.client.readHoldingRegisters(this.platform.speedRegister, 1);
      callback(null, response.data[0]);
    } catch (error) {
      this.platform.log.error('Error getting Speed:', error);
      this.isConnected = false;
      callback(error);
    }
  }

  async handleOnSetSpeed(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    try {
      await this.ensureConnection();
      const response = await this.client.readHoldingRegisters(this.platform.regimeRegister, 1);
      
      if (response.data[0] === 0) {
        await this.client.writeRegister(this.platform.regimeRegister, 2);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      await this.client.writeRegister(this.platform.speedRegister, value as number);
      callback(null);
    } catch (error) {
      this.platform.log.error('Error setting Speed:', error);
      this.isConnected = false;
      callback(error);
    }
  }
}