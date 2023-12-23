import { devices, HID } from "node-hid";
import crc16ccitt from "./crc16_ccitt.js";
import { Buffer } from "buffer";
import models from "./modellist.json";

// NOTES: A voir pour comprendre mieux l'utilité de chaques fonctions et mieux type safe

export {
  LETypes,
  magicNumber,
  getInfoFromLEBuffer,
  getLEBufferFromInfo,
} from "./lefile";
export {
  KeyCodes,
  CodeByKeys,
  KeyNames,
  KeyModifiers,
  ModifierByKeys,
} from "./keys";
export class THDevice {
  serialNumber: string | undefined;
  manufacturer: string | undefined;
  product: string | undefined;
  release: number;
  device: HID;
  onError: any;
  responses: {};
  onData: any;
  list() {
    return devices().filter(
      (d) => d.vendorId === 0x1ea7 && d.productId === 0x907
    );
  }

  // fix keyboard if you ran writeMacVid()
  static writeNormalVid() {
    // has apple info, but also reports it's manufacturer-name as SEMITEK
    const screwedUpKeyboard = devices().find(
      (d) =>
        d.manufacturer === "SEMITEK" &&
        d.vendorId === 1452 &&
        d.productId === 591 &&
        d.usagePage === 65280
    );

    if (!screwedUpKeyboard) {
      throw new Error("Apple keyboard with bad manufacturer not found!");
    }

    const device = new HID(screwedUpKeyboard.path!);
    const buffer = Buffer.alloc(64);
    buffer.fill(0);
    buffer.writeUInt8(0x41, 0);
    buffer.writeUInt16LE(crc16ccitt(buffer), 6);
    device.write(buffer);
  }

  constructor() {
    const keyboards = this.list();

    // on mine, there were many /dev/hidraw* but only usagePage=0xff00 works
    const dev = keyboards.find((k) => k.usagePage === 0xff00);

    if (keyboards.length === 0 || !dev) {
      throw new Error("No keyboard found.");
    }

    this.serialNumber = dev.serialNumber;
    this.manufacturer = dev.manufacturer;
    this.product = dev.product;
    this.release = dev.release;
    this.device = new HID(dev.path!);

    this.device.on("error", (error) => {
      console.error("ERROR", error);
      if (this.onError) {
        this.onError(error);
      }
    });

    // key responses by command, so they can be returned
    this.responses = {};
    this.device.on("data", (data) => {
      this.responses[data[0]] = data;
      if (this.onData) {
        this.onData(data);
      }
    });
  }

  // cleanup handle & intervals
  close() {
    this.device.close();
  }

  // fire a command to keyboard
  // promise resolves on answer or errors on timeout
  cmd(
    cmd: any,
    sub_cmd = 0,
    header = 0,
    body?: any,
    timeout = 1000
  ): Promise<Buffer> {
    const buffer = Buffer.alloc(64);
    buffer.writeUInt8(cmd, 0);
    buffer.writeUInt8(sub_cmd, 1);
    buffer.writeUInt32LE(header, 2);
    if (body) {
      body.copy(buffer, 8, 0, body.length);
    }
    buffer.writeUInt16LE(crc16ccitt(buffer), 6);
    delete this.responses[cmd];
    this.device.write(buffer);

    if (timeout) {
      return new Promise((resolve, reject) => {
        let time = 0;
        const i = setInterval(() => {
          time += 1;
          if (time >= timeout) {
            clearInterval(i);
            return reject(new Error("Timeout"));
          }
          if (this.responses[cmd]) {
            clearInterval(i);
            return resolve(this.responses[cmd]);
          }
        }, 1);
      });
    } else {
      // TODO: return with buffer something
      return null as any;
    }
  }

  // BE CAREFUL!!!
  // permanaently makes it look like a mac keyboard to OS
  // which makes it basically not work with this lib!
  // 05ac:024f Apple, Inc. Aluminium Keyboard (ANSI)
  // use Gk6xDevice.writeNormalVid() to fix it
  // I broke my keyboard in testing, and had to guess how to fix it
  writeMacVid() {
    return this.cmd(0x41, 0x01);
  }

  // set keyboard mode
  changeMode(mode) {
    return this.cmd(0x0b, mode).then((buffer) => buffer.readUInt8(1));
  }

  // check if the device is available
  ping() {
    return this.cmd(0x0c, 0, 0, 0, 5000);
  }

  // get firmware version from keyboard
  async version() {
    return this.cmd(0x01, 0x01).then((buffer) => ({
      id: buffer.readUInt32LE(8),
      version: buffer.readUInt16LE(12),
    }));
  }

  // get device-id from keyboard
  async deviceId() {
    return this.cmd(0x01, 0x02).then((buffer) => {
      let deviceId = 0;
      for (let i = 0; i < 6; i++) {
        //@ts-ignore
        deviceId |= BigInt(buffer[8 + i]) << BigInt(i * 8);
        //@ts-ignore
        return BigInt.asUintN(64, deviceId).toString(10);
      }
    });
  }

  // get model-id from keyboard
  async modelId() {
    return this.cmd(0x01, 0x08).then((buffer) => buffer.readUInt32LE(8));
  }

  async modelInfo() {
    const i = await this.modelId();
    const model = models.find((m) => m.ModelID === i);
    return model;
  }

  // get key-matrix from keyboard
  async matrix() {
    return await this.cmd(0x01, 0x09).then((buffer) => ({
      col: buffer.readUInt8(8),
      row: buffer.readUInt8(9),
    }));
  }

  async cleanData(mode: number, dataType: number) {
    return await this.cmd(0x21, mode, dataType).then((buffer) => ({
      ack: buffer.readUInt8(1),
      buffer,
    }));
  }

  async writeKeyData(mode: number, addr: any, data: any) {
    const header = (data.length << 16) + addr;
    return await this.cmd(0x22, mode, header, data).then((buffer) => ({
      ack: buffer.readUInt8(1),
      crc: buffer.readUInt16LE(6),
    }));
  }

  // TODO: what is 0x23?

  async writeModeLE(mode: number, addr: any, data: any) {
    const header = (data.length << 16) + addr;
    return await this.cmd(0x24, mode, header, data).then((buffer) => ({
      ack: buffer.readUInt8(1),
      crc: buffer.readUInt16LE(6),
    }));
  }

  async writeMacro(mode: number, addr: any, data: any) {
    const header = (data.length << 16) + addr;
    return await this.cmd(0x25, mode, header, data).then((buffer) => ({
      ack: buffer.readUInt8(1),
      crc: buffer.readUInt16LE(6),
    }));
  }

  async writeLightKey(mode: number, addr: any, data: any) {
    const header = (data.length << 16) + addr;
    return await this.cmd(0x26, mode, header, data).then((buffer) => ({
      ack: buffer.readUInt8(1),
      crc: buffer.readUInt16LE(6),
    }));
  }

  async writeLightData(mode: number, addr: any, data: any) {
    const header = (data.length << 16) + addr;
    return await this.cmd(0x27, mode, header, data).then((buffer) => ({
      ack: buffer.readUInt8(1),
      crc: buffer.readUInt16LE(6),
    }));
  }

  // TODO: what is 0x28?
  // TODO: what is 0x29?
  // TODO: what is 0x30?

  async writeFnData(mode: number, addr: any, data: any) {
    const header = (data.length << 16) + addr;
    return await this.cmd(0x31, mode, header, data).then((buffer) => ({
      ack: buffer.readUInt8(1),
      crc: buffer.readUInt16LE(6),
    }));
  }

  // tell keyboard to report keys or not
  async setKeyReport(enabled: boolean) {
    return await this.cmd(
      0x15,
      0x03,
      0,
      Buffer.from([enabled ? 0x01 : 0x00]),
      0
    );
  }

  async keyEvent(data: any) {
    return await this.cmd(0x15, 0x02, 0, Buffer.from(data));
  }

  async mouseEvent(mouse: any) {
    return await this.cmd(0x15, 0x01, 0, Buffer.from([mouse]));
  }

  async setKeyTable(byTableTyte: number, wAddr: any, BbyData: any) {
    const header = wAddr + ((BbyData.length << 24) & 0xff000000);
    return this.cmd(0x16, byTableTyte, header, BbyData).then(
      (buffer) => buffer.readUInt8(1) === 1
    );
  }

  async setLEConfig({
    byLEModel,
    byLESubModel,
    byLELight,
    byLESpeed,
    byLEDir,
    byR,
    byG,
    byB,
    bEnable,
  }: {
    byLEModel: number;
    byLESubModel: number;
    byLELight: number;
    byLESpeed: number;
    byLEDir: number;
    byR: number;
    byG: number;
    byB: number;
    bEnable: number;
  }) {
    const body = Buffer.alloc(9);
    body.writeUInt8(byLEModel, 0);
    body.writeUInt8(byLESubModel, 1);
    body.writeUInt8(byLELight, 2);
    body.writeUInt8(byLESpeed, 3);
    body.writeUInt8(byLEDir, 4);
    body.writeUInt8(byR, 5);
    body.writeUInt8(byG, 6);
    body.writeUInt8(byB, 7);
    body.writeUInt8(bEnable * 1, 8);
    return await this.cmd(0x17, 0x01, 0, body).then(
      (buffer) => buffer.readUInt8(1) === 1
    );
  }

  async setLEDefine(wAddr: any, BbyData: any) {
    const header = wAddr + ((BbyData.length << 24) & 0xff000000);
    return await this.cmd(0x1a, 0x01, header, BbyData).then(
      (buffer) => buffer.readUInt8(1) === 1
    );
  }

  async saveLEDefine() {
    return await this.cmd(0x1a, 0x02).then(
      (buffer) => buffer.readUInt8(1) === 1
    );
  }
}
