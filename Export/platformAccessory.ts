import { Service, PlatformAccessory, CharacteristicValue, CharacteristicSetCallback, CharacteristicGetCallback } from 'homebridge';
import { HRUPlatform } from './platform';
import ModbusRTU from 'modbus-serial';

interface CachedValue<T> {
  value: T;
  timestamp: number;
  ttl: number;
}

interface ConnectionHealth {
  lastSuccessfulOperation: number;
  consecutiveFailures: number;
  totalOperations: number;
  successRate: number;
}

interface ConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  isDisconnecting: boolean;
  connectionId: string;
  lastConnectionAttempt: number;
}

export class HRUAccessory {
  private service: Service;
  private client: ModbusRTU | null = null;
  
  // CRITICAL: Instance tracking to prevent duplicates
  private static instanceCount: number = 0;
  private static activeConnections = new Map<string, HRUAccessory>();
  private readonly instanceId: string;
  private readonly connectionKey: string;
  
  // Enhanced connection state management
  private connectionState: ConnectionState = {
    isConnected: false,
    isConnecting: false,
    isDisconnecting: false,
    connectionId: '',
    lastConnectionAttempt: 0
  };
  
  // Synchronization primitives
  private readonly connectionMutex = new AsyncMutex();
  private readonly operationMutex = new AsyncMutex();
  private connectionPromise?: Promise<void>;
  private disconnectionPromise?: Promise<void>;
  
  // Timeouts and intervals tracking
  private timeoutRegistry = new Set<NodeJS.Timeout>();
  private reconnectTimeout?: NodeJS.Timeout;
  private heartbeatTimeout?: NodeJS.Timeout;
  
  // Operation management
  private operationQueue: Array<() => Promise<any>> = [];
  private isProcessingQueue: boolean = false;
  private lastOperation: number = 0;
  
  // Configuration with stricter defaults
  private readonly operationThrottle: number;
  private readonly connectionRetryBaseDelay: number = 5000;
  private readonly maxRetries: number;
  private readonly heartbeatInterval: number;
  private readonly cacheTimeout: number;
  private readonly connectionTimeout: number;
  private readonly operationTimeout: number = 15000;
  private readonly maxConcurrentOperations: number = 3;
  
  // State management
  private connectionRetryCount: number = 0;
  private cache = new Map<string, CachedValue<any>>();
  private connectionHealth: ConnectionHealth = {
    lastSuccessfulOperation: 0,
    consecutiveFailures: 0,
    totalOperations: 0,
    successRate: 100
  };
  
  // Batch operations
  private pendingReads = new Map<number, Promise<any>>();
  private batchTimeout?: NodeJS.Timeout;
  
  // Cleanup state
  private isCleaningUp: boolean = false;
  private cleanupPromise?: Promise<void>;
  
  // Resource tracking
  private activeOperations = new Set<Promise<any>>();

  constructor(
    private readonly platform: HRUPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    // Generate unique instance and connection identifiers
    this.instanceId = `hru-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.connectionKey = `${this.platform.ip}:${this.platform.port}`;
    
    // CRITICAL: Check for existing connections to same device
    this.checkForDuplicateConnections();
    
    // Extract configuration with safe defaults
    this.operationThrottle = this.platform.operationThrottle || 1000; // Increased default
    this.maxRetries = this.platform.maxRetries || 3; // Reduced default
    this.heartbeatInterval = this.platform.heartbeatInterval || 60000; // Increased default
    this.cacheTimeout = this.platform.cacheTimeout || 3000; // Increased default
    this.connectionTimeout = this.platform.connectionTimeout || 10000; // Increased default
    
    // Register this instance
    HRUAccessory.instanceCount++;
    HRUAccessory.activeConnections.set(this.connectionKey, this);
    
    this.platform.log.info(`Creating HRU instance ${this.instanceId} for ${this.connectionKey} (total instances: ${HRUAccessory.instanceCount})`);
    
    this.initializeAccessory();
    this.setupCleanupHandlers();
    this.initializeConnection();
  }

  private checkForDuplicateConnections(): void {
    const existing = HRUAccessory.activeConnections.get(this.connectionKey);
    if (existing && existing !== this) {
      this.platform.log.error(`CRITICAL: Duplicate connection detected for ${this.connectionKey}! Cleaning up existing instance.`);
      existing.forceCleanup();
      HRUAccessory.activeConnections.delete(this.connectionKey);
    }
    
    if (HRUAccessory.instanceCount > 1) {
      this.platform.log.warn(`WARNING: Multiple HRU instances detected (${HRUAccessory.instanceCount}). This may cause connection conflicts.`);
    }
  }

  private initializeAccessory(): void {
    // Accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'ATREA')
      .setCharacteristic(this.platform.Characteristic.Model, 'HRU Device')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `HRU-${this.platform.ip.replace(/\./g, '')}-${this.instanceId.substr(-6)}`);

    // Fan service
    this.service = this.accessory.getService(this.platform.Service.Fan) || 
                   this.accessory.addService(this.platform.Service.Fan);
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'ATREA HRU');

    // Characteristics with optimized handlers
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .on('get', this.handleOnGetOn.bind(this))
      .on('set', this.handleOnSetOn.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .on('get', this.handleOnGetSpeed.bind(this))
      .on('set', this.handleOnSetSpeed.bind(this));
  }

  private async initializeConnection(): Promise<void> {
    try {
      await this.connectModbusClient();
      this.startHeartbeat();
    } catch (error) {
      this.platform.log.error(`Failed to establish initial connection for ${this.instanceId}:`, error);
      this.scheduleReconnect();
    }
  }

  private setupCleanupHandlers(): void {
    // Setup cleanup handlers only once per instance
    const cleanup = () => this.forceCleanup();
    
    // Note: We're not adding process listeners here to avoid multiple listeners
    // The platform should handle process-level cleanup
  }

  // **ENHANCED CONNECTION MANAGEMENT WITH STRICT DUPLICATE PREVENTION**
  
  private async connectModbusClient(): Promise<void> {
    return this.connectionMutex.execute(async () => {
      // Check if already connected or connecting
      if (this.connectionState.isConnected && !this.connectionState.isDisconnecting) {
        this.platform.log.debug(`${this.instanceId}: Already connected`);
        return;
      }
      
      if (this.connectionState.isConnecting) {
        this.platform.log.debug(`${this.instanceId}: Connection already in progress`);
        if (this.connectionPromise) {
          return this.connectionPromise;
        }
      }
      
      // Prevent too frequent connection attempts
      const timeSinceLastAttempt = Date.now() - this.connectionState.lastConnectionAttempt;
      if (timeSinceLastAttempt < 2000) {
        throw new Error(`Connection attempt too soon (${timeSinceLastAttempt}ms ago)`);
      }
      
      this.connectionPromise = this.doConnect();
      try {
        await this.connectionPromise;
      } finally {
        this.connectionPromise = undefined;
      }
    });
  }

  private async doConnect(): Promise<void> {
    if (this.isCleaningUp) {
      throw new Error('Cannot connect during cleanup');
    }
    
    this.connectionState.isConnecting = true;
    this.connectionState.lastConnectionAttempt = Date.now();
    
    try {
      // Force close any existing connection
      await this.forceCloseConnection();
      
      // Wait a moment for complete cleanup
      await this.sleep(1000);
      
      const startTime = Date.now();
      const connectionId = `conn-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
      this.connectionState.connectionId = connectionId;
      
      this.platform.log.debug(`${this.instanceId}: Connecting to ${this.platform.ip}:${this.platform.port} (attempt ${this.connectionRetryCount + 1}, connId: ${connectionId})`);
      
      // Create fresh client instance
      this.client = new ModbusRTU();
      this.configureModbusClient();
      
      // Connect with timeout
      await Promise.race([
        this.client.connectTCP(this.platform.ip, { 
          port: this.platform.port, 
          timeout: this.connectionTimeout 
        }),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error(`Connection timeout after ${this.connectionTimeout}ms`)), this.connectionTimeout)
        )
      ]);
      
      // Verify connection is still valid (not replaced during connect)
      if (this.connectionState.connectionId !== connectionId) {
        throw new Error('Connection was superseded during setup');
      }
      
      const connectionTime = Date.now() - startTime;
      this.connectionState.isConnected = true;
      this.connectionRetryCount = 0;
      this.clearCache(); // Clear stale cache
      
      this.platform.log.info(`${this.instanceId}: Connected to ATREA HRU in ${connectionTime}ms (connId: ${connectionId})`);
      
      // Clear any pending reconnect
      this.clearReconnectTimeout();
      
    } catch (error) {
      this.connectionState.isConnected = false;
      this.connectionRetryCount++;
      
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.platform.log.error(`${this.instanceId}: Connection failed (${this.connectionRetryCount}/${this.maxRetries}): ${errorMsg}`);
      
      throw error;
    } finally {
      this.connectionState.isConnecting = false;
    }
  }

  private configureModbusClient(): void {
    if (!this.client) return;
    
    this.client.setTimeout(this.connectionTimeout);
    this.client.setID(1); // Modbus unit ID
    
    // Add error handlers to prevent unhandled rejections
    this.client.on?.('error', (error) => {
      this.platform.log.debug(`${this.instanceId}: Modbus client error:`, error);
      this.handleConnectionFailure();
    });
  }

  private async forceCloseConnection(): Promise<void> {
    if (!this.client) return;
    
    this.connectionState.isDisconnecting = true;
    
    try {
      // First try graceful close with short timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          this.client!.close(() => {
            this.platform.log.debug(`${this.instanceId}: Connection closed gracefully`);
            resolve();
          });
        }),
        new Promise<void>((_, reject) => 
          setTimeout(() => reject(new Error('Graceful close timeout')), 2000)
        )
      ]);
    } catch (error) {
      this.platform.log.debug(`${this.instanceId}: Graceful close failed, forcing:`, error);
      
      // Force close
      try {
        this.client.close(() => {});
      } catch (e) {
        // Ignore force close errors
      }
    }
    
    // Clear client reference
    this.client = null;
    this.connectionState.isConnected = false;
    this.connectionState.isDisconnecting = false;
    this.connectionState.connectionId = '';
  }

  // **SAFE HEARTBEAT MANAGEMENT**
  
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    if (this.isCleaningUp) return;

    const heartbeatTimeout = setTimeout(async () => {
      try {
        await this.performHealthCheck();
        // Only continue heartbeat if still connected and not cleaning up
        if (this.connectionState.isConnected && !this.isCleaningUp) {
          this.startHeartbeat();
        }
      } catch (error) {
        this.platform.log.debug(`${this.instanceId}: Heartbeat failed:`, error);
        this.handleConnectionFailure();
      }
    }, this.heartbeatInterval);
    
    this.heartbeatTimeout = heartbeatTimeout;
    this.timeoutRegistry.add(heartbeatTimeout);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.timeoutRegistry.delete(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
  }

  private async performHealthCheck(): Promise<void> {
    // Comprehensive state check
    if (!this.connectionState.isConnected || 
        this.isCleaningUp || 
        this.connectionState.isConnecting || 
        this.connectionState.isDisconnecting) {
      this.platform.log.debug(`${this.instanceId}: Skipping heartbeat - invalid state`);
      return;
    }
    
    try {
      // Heartbeat with timeout
      await Promise.race([
        this.batchReadRegister(this.platform.regimeRegister),
        new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error('Heartbeat timeout')), 5000)
        )
      ]);
      this.updateConnectionHealth(true);
    } catch (error) {
      this.updateConnectionHealth(false);
      throw error;
    }
  }

  // **SAFE OPERATION QUEUE WITH CONCURRENCY LIMITS**
  
  private async addToQueue<T>(operation: () => Promise<T>, priority: boolean = false): Promise<T> {
    if (this.isCleaningUp) {
      throw new Error('Cannot add operations during cleanup');
    }
    
    if (this.activeOperations.size >= this.maxConcurrentOperations) {
      throw new Error('Too many concurrent operations');
    }
    
    return new Promise((resolve, reject) => {
      const queuedOperation = async () => {
        const operationPromise = (async () => {
          try {
            const result = await operation();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        })();
        
        this.activeOperations.add(operationPromise);
        
        try {
          await operationPromise;
        } finally {
          this.activeOperations.delete(operationPromise);
        }
      };
      
      if (priority) {
        this.operationQueue.unshift(queuedOperation);
      } else {
        this.operationQueue.push(queuedOperation);
      }
      
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || this.operationQueue.length === 0 || this.isCleaningUp) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      while (this.operationQueue.length > 0 && !this.isCleaningUp) {
        const operation = this.operationQueue.shift();
        if (!operation) break;

        // Strict throttling
        const now = Date.now();
        const timeSinceLastOperation = now - this.lastOperation;
        if (timeSinceLastOperation < this.operationThrottle) {
          await this.sleep(this.operationThrottle - timeSinceLastOperation);
        }

        try {
          await operation();
          this.updateConnectionHealth(true);
        } catch (error) {
          this.updateConnectionHealth(false);
          this.platform.log.error(`${this.instanceId}: Queue operation failed:`, error);
        }

        this.lastOperation = Date.now();
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  // **SAFE RETRY MECHANISM**
  
  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    return this.addToQueue(async () => {
      // Ensure connection without race conditions
      if (!this.connectionState.isConnected && !this.connectionState.isConnecting) {
        await this.connectModbusClient();
      }

      // Wait for connection to be ready
      let waitCount = 0;
      while (this.connectionState.isConnecting && waitCount < 50) { // Max 5s wait
        await this.sleep(100);
        waitCount++;
      }

      if (!this.connectionState.isConnected) {
        throw new Error('Connection not available for operation');
      }

      try {
        return await operation();
      } catch (error) {
        this.platform.log.debug(`${this.instanceId}: Operation failed, attempting recovery:`, error);
        
        // Single recovery attempt
        this.handleConnectionFailure();
        
        // Try once more after recovery
        await this.connectModbusClient();
        if (this.connectionState.isConnected) {
          return await operation();
        } else {
          throw new Error('Retry failed - connection not restored');
        }
      }
    });
  }

  // **ENHANCED CACHING**
  
  private getCachedValue<T>(key: string): T | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > cached.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return cached.value;
  }

  private setCachedValue<T>(key: string, value: T, ttl: number = this.cacheTimeout): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl
    });
  }

  private clearCache(): void {
    this.cache.clear();
    this.pendingReads.clear();
  }

  // **SAFE BATCH OPERATIONS**
  
  private async batchReadRegister(register: number): Promise<any> {
    const cacheKey = `read_${register}`;
    
    // Check cache first
    const cached = this.getCachedValue(cacheKey);
    if (cached !== null) {
      this.platform.log.debug(`${this.instanceId}: Cache hit for register ${register}`);
      return cached;
    }

    // Check if same read is already pending
    if (this.pendingReads.has(register)) {
      this.platform.log.debug(`${this.instanceId}: Joining existing read for register ${register}`);
      return this.pendingReads.get(register);
    }

    // Create new read operation
    const readPromise = this.executeWithRetry(async () => {
      if (!this.client) {
        throw new Error('No client available');
      }
      const response = await this.client.readHoldingRegisters(register, 1);
      return response.data[0];
    }).then(value => {
      this.setCachedValue(cacheKey, value);
      this.pendingReads.delete(register);
      return value;
    }).catch(error => {
      this.pendingReads.delete(register);
      throw error;
    });

    this.pendingReads.set(register, readPromise);
    return readPromise;
  }

  // **CHARACTERISTIC HANDLERS WITH ENHANCED SAFETY**
  
  private async executeCharacteristicOperation<T>(
    operation: () => Promise<T>, 
    callback: (error: any, value?: T) => void,
    timeoutMs?: number
  ): Promise<void>;
  
  private async executeCharacteristicOperation(
    operation: () => Promise<void>, 
    callback: (error: any) => void,
    timeoutMs?: number
  ): Promise<void>;
  
  private async executeCharacteristicOperation<T>(
    operation: () => Promise<T | void>, 
    callback: (error: any, value?: T) => void,
    timeoutMs?: number
  ): Promise<void> {
    const actualTimeout = timeoutMs || this.operationTimeout;
    let timeoutId: NodeJS.Timeout | undefined;
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Operation timeout after ${actualTimeout}ms`));
      }, actualTimeout);
      this.timeoutRegistry.add(timeoutId);
    });

    try {
      const result = await Promise.race([
        this.executeWithRetry(operation),
        timeoutPromise
      ]);
      
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.timeoutRegistry.delete(timeoutId);
      }
      
      if (result !== undefined) {
        callback(null, result as T);
      } else {
        callback(null);
      }
    } catch (error) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        this.timeoutRegistry.delete(timeoutId);
      }
      
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      this.platform.log.error(`${this.instanceId}: Characteristic operation failed: ${errorMsg}`);
      callback(error);
    }
  }

  handleOnGetOn(callback: CharacteristicGetCallback) {
    this.executeCharacteristicOperation(
      async () => {
        const value = await this.batchReadRegister(this.platform.regimeRegister);
        const isOn = value === 0 ? 0 : 1;
        this.platform.log.debug(`${this.instanceId}: State: ${isOn} (raw: ${value})`);
        return isOn;
      },
      callback
    );
  }

  handleOnSetOn(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.executeCharacteristicOperation(
      async () => {
        if (!this.client) {
          throw new Error('No client available');
        }
        
        const setValue = (value as number) >= 1 ? 2 : 0;
        await this.client.writeRegister(this.platform.regimeRegister, setValue);
        
        // Invalidate cache
        this.cache.delete(`read_${this.platform.regimeRegister}`);
        
        this.platform.log.debug(`${this.instanceId}: Set state to: ${value} (wrote: ${setValue})`);
      },
      callback
    );
  }

  handleOnGetSpeed(callback: CharacteristicGetCallback) {
    this.executeCharacteristicOperation(
      async () => {
        const value = await this.batchReadRegister(this.platform.speedRegister);
        this.platform.log.debug(`${this.instanceId}: Speed: ${value}%`);
        return value;
      },
      callback
    );
  }

  handleOnSetSpeed(value: CharacteristicValue, callback: CharacteristicSetCallback) {
    this.executeCharacteristicOperation(
      async () => {
        if (!this.client) {
          throw new Error('No client available');
        }
        
        const speed = value as number;
        
        // Check if device is on, turn on if needed
        const state = await this.batchReadRegister(this.platform.regimeRegister);
        if (state === 0 && speed > 0) {
          await this.client.writeRegister(this.platform.regimeRegister, 2);
          await this.sleep(800); // Wait for device response
        }
        
        // Set speed
        await this.client.writeRegister(this.platform.speedRegister, speed);
        
        // Invalidate relevant cache
        this.cache.delete(`read_${this.platform.regimeRegister}`);
        this.cache.delete(`read_${this.platform.speedRegister}`);
        
        this.platform.log.debug(`${this.instanceId}: Set speed to: ${speed}%`);
      },
      callback
    );
  }

  // **CONNECTION HEALTH AND MONITORING**
  
  private updateConnectionHealth(success: boolean): void {
    this.connectionHealth.totalOperations++;
    
    if (success) {
      this.connectionHealth.lastSuccessfulOperation = Date.now();
      this.connectionHealth.consecutiveFailures = 0;
    } else {
      this.connectionHealth.consecutiveFailures++;
    }
    
    this.connectionHealth.successRate = 
      ((this.connectionHealth.totalOperations - this.connectionHealth.consecutiveFailures) / 
       this.connectionHealth.totalOperations) * 100;
  }

  private handleConnectionFailure(): void {
    this.connectionState.isConnected = false;
    this.clearCache();
    
    if (this.connectionHealth.consecutiveFailures >= 3) {
      this.platform.log.warn(`${this.instanceId}: Multiple connection failures detected. Success rate: ${this.connectionHealth.successRate.toFixed(1)}%`);
    }
    
    this.scheduleReconnect();
  }

  private scheduleReconnect(delay?: number): void {
    this.clearReconnectTimeout();
    
    if (this.isCleaningUp) {
      return;
    }
    
    // Exponential backoff with jitter
    const baseDelay = delay || this.connectionRetryBaseDelay;
    const exponentialDelay = Math.min(baseDelay * Math.pow(2, this.connectionRetryCount), 60000);
    const jitter = Math.random() * 1000; // Add up to 1s jitter
    const reconnectDelay = exponentialDelay + jitter;
    
    if (this.connectionRetryCount >= this.maxRetries) {
      this.platform.log.error(`${this.instanceId}: Max retry attempts reached. Waiting ${Math.round(reconnectDelay/1000)}s before next attempt.`);
      this.connectionRetryCount = 0; // Reset for next cycle
    }
    
    const timeout = setTimeout(async () => {
      this.reconnectTimeout = undefined;
      this.timeoutRegistry.delete(timeout);
      
      if (this.isCleaningUp) {
        return;
      }
      
      try {
        await this.connectModbusClient();
        if (this.connectionState.isConnected) {
          this.startHeartbeat();
        }
      } catch (error) {
        this.platform.log.error(`${this.instanceId}: Reconnection failed:`, error);
        if (!this.isCleaningUp) {
          this.scheduleReconnect();
        }
      }
    }, reconnectDelay);
    
    this.reconnectTimeout = timeout;
    this.timeoutRegistry.add(timeout);
    
    this.platform.log.debug(`${this.instanceId}: Reconnection scheduled in ${Math.round(reconnectDelay)}ms`);
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.timeoutRegistry.delete(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
  }

  // **COMPREHENSIVE CLEANUP**
  
  public async disconnect(): Promise<void> {
    return this.cleanup();
  }

  public forceCleanup(): void {
    this.cleanup().catch(error => {
      this.platform.log.debug(`${this.instanceId}: Error during force cleanup:`, error);
    });
  }

  private async cleanup(): Promise<void> {
    if (this.isCleaningUp) {
      return this.cleanupPromise;
    }
    
    this.isCleaningUp = true;
    this.platform.log.debug(`${this.instanceId}: Starting cleanup...`);
    
    this.cleanupPromise = this.doCleanup();
    return this.cleanupPromise;
  }

  private async doCleanup(): Promise<void> {
    try {
      // Stop all timers
      this.stopHeartbeat();
      this.clearReconnectTimeout();
      
      // Clear all timeouts
      this.timeoutRegistry.forEach(timeout => clearTimeout(timeout));
      this.timeoutRegistry.clear();
      
      // Clear batch timeout
      if (this.batchTimeout) {
        clearTimeout(this.batchTimeout);
        this.batchTimeout = undefined;
      }
      
      // Clear queues and cache
      this.operationQueue = [];
      this.pendingReads.clear();
      this.clearCache();
      this.isProcessingQueue = false;
      
      // Wait for active operations to complete (with timeout)
      if (this.activeOperations.size > 0) {
        this.platform.log.debug(`${this.instanceId}: Waiting for ${this.activeOperations.size} active operations...`);
        await Promise.race([
          Promise.all(Array.from(this.activeOperations)),
          new Promise(resolve => setTimeout(resolve, 5000)) // 5s timeout
        ]);
      }
      
      // Close connection
      await this.forceCloseConnection();
      
      // Unregister instance
      HRUAccessory.activeConnections.delete(this.connectionKey);
      HRUAccessory.instanceCount = Math.max(0, HRUAccessory.instanceCount - 1);
      
      // Log final stats
      this.platform.log.info(`${this.instanceId}: Cleanup completed. Final stats - Operations: ${this.connectionHealth.totalOperations}, Success rate: ${this.connectionHealth.successRate.toFixed(1)}%`);
      
    } catch (error) {
      this.platform.log.debug(`${this.instanceId}: Error during cleanup:`, error);
    }
  }

  // **DIAGNOSTIC METHODS**
  
  public getConnectionHealth(): ConnectionHealth {
    return { ...this.connectionHealth };
  }

  public getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  public getConnectionState(): ConnectionState {
    return { ...this.connectionState };
  }

  public getInstanceInfo(): { id: string; connectionKey: string; isCleaningUp: boolean } {
    return {
      id: this.instanceId,
      connectionKey: this.connectionKey,
      isCleaningUp: this.isCleaningUp
    };
  }

  // **STATIC DIAGNOSTIC METHODS**
  
  public static getInstanceCount(): number {
    return HRUAccessory.instanceCount;
  }

  public static getActiveConnections(): string[] {
    return Array.from(HRUAccessory.activeConnections.keys());
  }

  public static async cleanupAllInstances(): Promise<void> {
    const instances = Array.from(HRUAccessory.activeConnections.values());
    await Promise.all(instances.map(instance => instance.cleanup()));
  }

  // **UTILITY METHODS**
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// **ASYNC MUTEX FOR SYNCHRONIZATION**
class AsyncMutex {
  private locked: boolean = false;
  private waitQueue: Array<() => void> = [];

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    while (this.locked) {
      await new Promise<void>(resolve => this.waitQueue.push(resolve));
    }

    this.locked = true;
    try {
      return await operation();
    } finally {
      this.locked = false;
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }
}