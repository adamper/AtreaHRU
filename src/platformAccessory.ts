/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Service, PlatformAccessory } from 'homebridge';

import { HRUPlatform } from './platform';

const ModbusRTU = require('modbus-serial');
const client = new ModbusRTU();

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class HRUAccessory {
  private service: Service;

  constructor(
    private readonly platform: HRUPlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    this.connectModbusClient();

    this.service = this.accessory.getService(this.platform.Service.Fan) || this.accessory.addService(this.platform.Service.Fan);
    //this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.exampleDisplayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGetOn.bind(this))
      .onSet(this.handleOnSetOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.handleOnGetSpeed.bind(this))
      .onSet(this.handleOnSetSpeed.bind(this));



  }

  async handleOnGetOn() {
    let currentValue;
    try {
      const response = await client.readInputRegisters(this.platform.regimeRegister, 1);
      currentValue = response.data[0];
      if (currentValue >= 2) {
        currentValue = 1;
      } else if (currentValue === 0) {
        //keep currentValue 0
      }


    //   return 1;
    } catch (error) {
      console.error(error);
    }

    // set this to a valid value for On
    this.platform.log.debug('State is:', currentValue);
    //currentValue = 1;

    return currentValue;
  }

  /**
   * Handle requests to set the "On" characteristic
   */
  async handleOnSetOn(value) {
    try{
      if (value >= 1) {
        value = 2;
      } else if (value === 0) {
        //keep currentValue 0
      }
      await client.writeRegisters(this.platform.regimeRegister, [value]);
    }catch (error) {
      console.error(error);
    }
  }

  async handleOnGetSpeed() {
    let currentValue;
    try {
      const response = await client.readInputRegisters(this.platform.speedRegister, 1);
      currentValue = response.data[0];


    //   return 1;
    } catch (error) {
      console.error(error);
    }

    // set this to a valid value for On
    this.platform.log.debug('Speed is:', currentValue);
    //currentValue = 1;

    return currentValue;
  }

  /**
   * Handle requests to set the "On" characteristic
   */
  async handleOnSetSpeed(value) {
    try{
      const response = await client.readInputRegisters(this.platform.regimeRegister, 1);
      const state = response.data[0];
      if (state === 0) {
        this.handleOnSetOn(1);
        this.delay(5000);
      }
      await client.writeRegisters(this.platform.speedRegister, [value]);
    }catch (error) {
      console.error(error);
    }
  }

  connectModbusClient() {
    client.connectTCP(this.platform.ip, { port: this.platform.port })
      .then(() => {
        this.platform.log.debug(`Připojeno k Modbus zařízení na adrese ${this.platform.ip}:${this.platform.port}`);
      })
      .catch((error) => {
        this.platform.log.debug(`Chyba při připojení k Modbus zařízení: ${error.message}`);
      });
  }

  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

}
