import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { HRUPlatform } from './platform';
import ModbusRTU from 'modbus-serial';

export class HRUAccessory {
  private service: Service;
  private client: ModbusRTU;
  private isConnected: boolean = false;
  private reconnectTimeout?: NodeJS.Timeout;
  private connectionPromise?: Promise<void>;

  constructor(
    private readonly platform: HRUPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.client = new ModbusRTU();
    
    // Inicializace připojení
    this.initializeConnection();

    // Nastavení accessory informací
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'HRU Manufacturer')
      .setCharacteristic(this.platform.Characteristic.Model, 'HRU Model')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'HRU Serial Number');

    // Nastavení fan service
    this.service = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'HRU Fan');

    // Nastavení charakteristik
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .on('get', this.handleOnGetOn.bind(this))
      .on('set', this.handleOnSetOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .on('get', this.handleOnGetSpeed.bind(this))
      .on('set', this.handleOnSetSpeed.bind(this));

    // Cleanup při ukončení procesu
    process.on('SIGTERM', this.cleanup.bind(this));
    process.on('SIGINT', this.cleanup.bind(this));
  }

  private async initializeConnection(): Promise<void> {
    try {
      await this.connectModbusClient();
    } catch (error) {
      this.platform.log.error('Failed to establish initial Modbus connection:', error);
      this.scheduleReconnect();
    }
  }

  private async connectModbusClient(): Promise<void> {
    // Pokud už probíhá připojování, počkáme na něj
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.doConnect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  private async doConnect(): Promise<void> {
    try {
      // Zavřeme existující připojení
      await this.closeConnection();

      this.platform.log.debug(`Attempting to connect to Modbus device at ${this.platform.ip}:${this.platform.port}`);
      
      // Vytvoříme nový klient pro případ, že starý je v špatném stavu
      this.client = new ModbusRTU();
      
      await this.client.connectTCP(this.platform.ip, { 
        port: this.platform.port, 
        timeout: 10000 
      });
      
      this.isConnected = true;
      this.platform.log.info(`Successfully connected to Modbus device at ${this.platform.ip}:${this.platform.port}`);
      
      // Zrušíme případný plánovaný reconnect
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
      
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

  private async closeConnection(): Promise<void> {
    if (this.client && this.isConnected) {
      try {
        this.client.close(() => {
          this.platform.log.debug('Modbus connection closed');
        });
      } catch (error) {
        this.platform.log.debug('Error closing connection:', error);
      }
    }
    this.isConnected = false;
  }

  private scheduleReconnect(delay: number = 30000): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    this.reconnectTimeout = setTimeout(async () => {
      try {
        await this.connectModbusClient();
      } catch (error) {
        this.platform.log.error('Reconnection failed:', error);
        this.scheduleReconnect(Math.min(delay * 2, 300000)); // Max 5 minut
      }
    }, delay);
  }

  private async ensureConnection(): Promise<void> {
    if (!this.isConnected) {
      await this.connectModbusClient();
    }
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await this.ensureConnection();
      return await operation();
    } catch (error) {
      this.platform.log.debug('Operation failed, marking connection as disconnected:', error);
      this.isConnected = false;
      
      // Pokusíme se znovu připojit a opakovat operaci
      try {
        await this.connectModbusClient();
        return await operation();
      } catch (retryError) {
        this.platform.log.error('Retry operation failed:', retryError);
        this.scheduleReconnect();
        throw retryError;
      }
    }
  }

  handleOnGetOn(callback: CharacteristicGetCallback) {
    this.executeWithRetry(async () => {
      const response = await this.client.readHoldingRegisters(this.platform.regimeRegister, 1);
      const currentValue = response.data[0] === 0 ? 0 : 1;
      this.platform.log.debug('State is:', currentValue);
      return currentValue;
    })
    .then(value => callback(null, value))
    .catch(error => {
      this.platform.log.error('Error getting On state:', error);
      callback(error);
    });
  }

  handleOnSetOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.executeWithRetry(async () => {
      const setValue = (value as number) >= 1 ? 2 : 0;
      await this.client.writeRegister(this.platform.regimeRegister, setValue);
      this.platform.log.debug(`Set On state to: ${value}`);
    })
    .then(() => callback(null))
    .catch(error => {
      this.platform.log.error('Error setting On state:', error);
      callback(error);
    });
  }

  handleOnGetSpeed(callback: CharacteristicGetCallback) {
    this.executeWithRetry(async () => {
      const response = await this.client.readHoldingRegisters(this.platform.speedRegister, 1);
      const currentValue = response.data[0];
      this.platform.log.debug('Speed is:', currentValue);
      return currentValue;
    })
    .then(value => callback(null, value))
    .catch(error => {
      this.platform.log.error('Error getting Speed:', error);
      callback(error);
    });
  }

  handleOnSetSpeed(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.executeWithRetry(async () => {
      // Nejdříve zkontrolujeme stav
      const response = await this.client.readHoldingRegisters(this.platform.regimeRegister, 1);
      const state = response.data[0];
      
      // Pokud je vypnuto, zapneme
      if (state === 0) {
        await this.client.writeRegister(this.platform.regimeRegister, 2);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      // Nastavíme rychlost
      await this.client.writeRegister(this.platform.speedRegister, value as number);
      this.platform.log.debug(`Set Speed to: ${value}`);
    })
    .then(() => callback(null))
    .catch(error => {
      this.platform.log.error('Error setting Speed:', error);
      callback(error);
    });
  }

  private cleanup(): void {
    this.platform.log.debug('Cleaning up HRU accessory...');
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    
    this.closeConnection().catch(error => {
      this.platform.log.debug('Error during cleanup:', error);
    });
  }

  // Volitelná metoda pro ruční odpojení
  public disconnect(): void {
    this.cleanup();
  }
}