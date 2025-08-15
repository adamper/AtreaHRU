import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HRUAccessory } from './platformAccessory';

interface HRUConfig extends PlatformConfig {
  ip?: string;
  port?: number;
  regimeRegister?: number;
  speedRegister?: number;
  connectionTimeout?: number;
  operationThrottle?: number;
  maxRetries?: number;
  heartbeatInterval?: number;
  cacheTimeout?: number;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  deviceName?: string;
}

interface PlatformDiagnostics {
  totalInstances: number;
  activeConnections: string[];
  deviceHealth: Array<{
    index: number;
    instanceId: string;
    connectionKey: string;
    successRate: number;
    operations: number;
    consecutiveFailures: number;
    cacheSize: number;
    isConnected: boolean;
    isConnecting: boolean;
    isCleaningUp: boolean;
  }>;
  platformHealth: number;
  anomalies: string[];
}

export class HRUPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly hruAccessories: HRUAccessory[] = [];

  // Configuration with strict validation and safe defaults
  public readonly ip: string;
  public readonly port: number;
  public readonly regimeRegister: number;
  public readonly speedRegister: number;
  public readonly connectionTimeout: number;
  public readonly operationThrottle: number;
  public readonly maxRetries: number;
  public readonly heartbeatInterval: number;
  public readonly cacheTimeout: number;
  public readonly deviceName: string;

  // Enhanced platform state management
  private configValidationErrors: string[] = [];
  private cleanupHandled: boolean = false;
  private shutdownInitiated: boolean = false;
  private healthCheckInterval?: NodeJS.Timeout;
  private diagnosticsInterval?: NodeJS.Timeout;
  private platformStartTime: number = Date.now();
  
  // Enhanced resource tracking
  private timeoutRegistry = new Set<NodeJS.Timeout>();
  private cleanupPromise?: Promise<void>;
  
  // Platform-level connection coordination
  private readonly platformId: string;
  private readonly maxDevicesPerPlatform: number = 1; // ATREA units typically one per platform
  
  // Diagnostic state
  private lastDiagnostics?: PlatformDiagnostics;
  private consecutiveHealthCheckFailures: number = 0;

  constructor(
    public readonly log: Logger,
    public readonly config: HRUConfig,
    public readonly api: API,
  ) {
    // Generate unique platform identifier
    this.platformId = `platform-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    
    // Initialize services
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.info(`Initializing ATREA HRU Platform ${this.platformId}`);

    // Validate and set configuration with enhanced validation
    this.validateConfiguration();
    
    // Set configuration with safe defaults
    this.ip = config.ip || '192.168.1.100';
    this.port = config.port || 502;
    this.regimeRegister = config.regimeRegister || 1000;
    this.speedRegister = config.speedRegister || 1001;
    this.connectionTimeout = Math.max(config.connectionTimeout || 10000, 5000); // Min 5s
    this.operationThrottle = Math.max(config.operationThrottle || 1000, 500); // Min 500ms
    this.maxRetries = Math.min(Math.max(config.maxRetries || 3, 1), 10); // 1-10 range
    this.heartbeatInterval = Math.max(config.heartbeatInterval || 60000, 30000); // Min 30s
    this.cacheTimeout = Math.max(config.cacheTimeout || 3000, 1000); // Min 1s
    this.deviceName = config.name || config.deviceName || 'ATREA HRU';

    // Enhanced configuration logging
    this.logConfiguration();

    // Stop initialization if critical validation errors exist
    if (this.configValidationErrors.length > 0) {
      this.log.error('Critical configuration validation failed:');
      this.configValidationErrors.forEach(error => this.log.error(`  ❌ ${error}`));
      this.log.error('Platform initialization aborted due to configuration errors');
      return;
    }

    this.log.debug(`Platform ${this.platformId} initialized successfully`);

    // Enhanced event handlers with better coordination
    this.setupEventHandlers();
    
    // Start platform diagnostics
    this.startPlatformDiagnostics();
  }

  private setupEventHandlers(): void {
    // Homebridge lifecycle events
    this.api.on('didFinishLaunching', () => {
      this.log.debug(`Homebridge finished launching, platform ${this.platformId} discovering devices...`);
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      this.log.debug(`Homebridge shutdown initiated for platform ${this.platformId}`);
      this.initiateShutdown();
    });

    // Enhanced process handlers with coordination
    const handleShutdown = async (signal: string) => {
      this.log.info(`Platform ${this.platformId} received ${signal}, initiating cleanup...`);
      await this.initiateShutdown();
      
      // Give some time for cleanup before forcing exit
      setTimeout(() => {
        this.log.warn(`Platform ${this.platformId} forcing exit after cleanup timeout`);
        process.exit(signal === 'SIGTERM' ? 0 : 1);
      }, 15000); // 15s timeout for cleanup
    };

    // Only setup process handlers if not already setup by another platform instance
    if (!process.listenerCount('SIGTERM')) {
      process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    }
    if (!process.listenerCount('SIGINT')) {
      process.on('SIGINT', () => handleShutdown('SIGINT'));
    }
    
    process.on('uncaughtException', (error) => {
      this.log.error(`Platform ${this.platformId} uncaught exception:`, error);
      this.initiateShutdown().then(() => {
        setTimeout(() => process.exit(1), 2000);
      });
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.log.error(`Platform ${this.platformId} unhandled rejection at:`, promise, 'reason:', reason);
      // Don't exit on unhandled rejection, just log it
    });
  }

  private validateConfiguration(): void {
    const config = this.config as HRUConfig;
    
    this.log.debug('Validating platform configuration...');
    
    // Enhanced IP address validation
    if (config.ip) {
      if (!this.isValidIP(config.ip)) {
        this.configValidationErrors.push(`Invalid IP address format: ${config.ip}`);
      } else if (this.isPrivateIPReserved(config.ip)) {
        this.log.warn(`IP address ${config.ip} is in reserved range - ensure device is accessible`);
      }
    }

    // Enhanced port validation
    if (config.port !== undefined) {
      if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        this.configValidationErrors.push(`Invalid port number: ${config.port}. Must be integer between 1-65535`);
      } else if (config.port < 1024 && config.port !== 502) {
        this.log.warn(`Port ${config.port} is in privileged range. Standard Modbus port is 502`);
      }
    }

    // Enhanced register validation
    if (config.regimeRegister !== undefined) {
      if (!Number.isInteger(config.regimeRegister) || config.regimeRegister < 0 || config.regimeRegister > 65535) {
        this.configValidationErrors.push(`Invalid regime register: ${config.regimeRegister}. Must be integer 0-65535`);
      }
    }

    if (config.speedRegister !== undefined) {
      if (!Number.isInteger(config.speedRegister) || config.speedRegister < 0 || config.speedRegister > 65535) {
        this.configValidationErrors.push(`Invalid speed register: ${config.speedRegister}. Must be integer 0-65535`);
      }
    }

    // Check for register conflicts
    if (config.regimeRegister !== undefined && config.speedRegister !== undefined) {
      if (config.regimeRegister === config.speedRegister) {
        this.configValidationErrors.push('Regime and speed registers cannot be the same value');
      }
      
      // Check for adjacent registers that might conflict
      if (Math.abs(config.regimeRegister - config.speedRegister) === 1) {
        this.log.warn('Regime and speed registers are adjacent - ensure this is intentional');
      }
    }

    // Enhanced timeout validations with warnings
    if (config.connectionTimeout !== undefined) {
      if (config.connectionTimeout < 1000) {
        this.log.warn('Connection timeout is very low (<1s) - may cause frequent connection failures');
      } else if (config.connectionTimeout > 30000) {
        this.log.warn('Connection timeout is very high (>30s) - may cause slow recovery from failures');
      }
    }

    if (config.operationThrottle !== undefined) {
      if (config.operationThrottle < 100) {
        this.log.warn('Operation throttle is very low (<100ms) - may overwhelm the device');
      } else if (config.operationThrottle > 5000) {
        this.log.warn('Operation throttle is very high (>5s) - may cause slow device response');
      }
    }

    // Validate heartbeat interval
    if (config.heartbeatInterval !== undefined) {
      if (config.heartbeatInterval < 10000) {
        this.log.warn('Heartbeat interval is very low (<10s) - may cause unnecessary load');
      } else if (config.heartbeatInterval > 300000) {
        this.log.warn('Heartbeat interval is very high (>5min) - may not detect failures quickly');
      }
    }

    // Validate device name
    if (config.deviceName && config.deviceName.length > 64) {
      this.log.warn('Device name is very long - may be truncated in some interfaces');
    }

    // Validate max retries
    if (config.maxRetries !== undefined) {
      if (config.maxRetries < 1) {
        this.configValidationErrors.push('Max retries must be at least 1');
      } else if (config.maxRetries > 10) {
        this.log.warn('Max retries is high (>10) - may cause long delays during failures');
      }
    }

    const errorCount = this.configValidationErrors.length;
    if (errorCount === 0) {
      this.log.debug('✅ Configuration validation passed');
    } else {
      this.log.error(`❌ Configuration validation failed with ${errorCount} error(s)`);
    }
  }

  private isValidIP(ip: string): boolean {
    const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    return ipRegex.test(ip);
  }

  private isPrivateIPReserved(ip: string): boolean {
    // Check for commonly reserved IPs that might not be accessible
    const reserved = [
      '192.168.1.1',   // Common router IP
      '192.168.0.1',   // Common router IP
      '10.0.0.1',      // Common router IP
      '172.16.0.1'     // Common router IP
    ];
    return reserved.includes(ip);
  }

  private logConfiguration(): void {
    this.log.info('🔋 ATREA HRU Platform Configuration:');
    this.log.info(`   🔧 Platform ID: ${this.platformId}`);
    this.log.info(`   📱 Device: ${this.deviceName}`);
    this.log.info(`   🌐 Address: ${this.ip}:${this.port}`);
    this.log.info(`   📊 Registers: Regime=${this.regimeRegister}, Speed=${this.speedRegister}`);
    this.log.info(`   ⏱️  Timeouts: Connection=${this.connectionTimeout}ms, Cache=${this.cacheTimeout}ms`);
    this.log.info(`   🔄 Limits: MaxRetries=${this.maxRetries}, Throttle=${this.operationThrottle}ms`);
    this.log.info(`   💚 Heartbeat: ${this.heartbeatInterval}ms`);
    
    if (this.config.logLevel === 'debug') {
      this.log.debug('🔍 Debug mode enabled - verbose logging active');
    }
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(`Loading accessory from cache: ${accessory.displayName} (UUID: ${accessory.UUID})`);
    
    // Enhanced cached accessory validation
    if (!accessory.UUID) {
      this.log.warn('❌ Cached accessory missing UUID, will be recreated');
      return;
    }

    // Validate accessory context
    if (!accessory.context.device) {
      this.log.warn('⚠️  Cached accessory missing device context, may need reconfiguration');
    } else {
      const deviceContext = accessory.context.device;
      this.log.debug(`🔋 Cached device context: IP=${deviceContext.ip}, Port=${deviceContext.port}`);
      
      // Check if cached context matches current config
      if (deviceContext.ip !== this.ip || deviceContext.port !== this.port) {
        this.log.warn(`⚠️  Cached device context mismatch. Cached: ${deviceContext.ip}:${deviceContext.port}, Current: ${this.ip}:${this.port}`);
      }
    }

    this.accessories.push(accessory);
  }

  discoverDevices() {
    if (this.shutdownInitiated) {
      this.log.warn('⚠️  Shutdown initiated, skipping device discovery');
      return;
    }

    if (this.configValidationErrors.length > 0) {
      this.log.error('❌ Skipping device discovery due to configuration errors');
      return;
    }

    try {
      this.log.info('🔍 Starting device discovery...');
      
      // Enhanced device identification to prevent duplicates
      const deviceId = `${this.ip.replace(/\./g, '-')}-${this.port}-${this.regimeRegister}-${this.speedRegister}`;
      const uuid = this.api.hap.uuid.generate(`homebridge-atrea-${deviceId}`);
      
      // Check for duplicate device configuration
      const existingCount = this.hruAccessories.length;
      if (existingCount > 0) {
        this.log.warn(`⚠️  Already have ${existingCount} HRU device(s). Check for duplicate configuration.`);
      }
      
      // Check platform limits
      if (existingCount >= this.maxDevicesPerPlatform) {
        this.log.error(`❌ Maximum devices per platform exceeded (${this.maxDevicesPerPlatform}). Current: ${existingCount}`);
        return;
      }
      
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      // 🔧 OPRAVA: Přidán flag pro sledování úspěšného vytvoření accessory
      let accessoryCreated = false;

      if (existingAccessory) {
        this.log.info(`♻️  Restoring existing accessory from cache: ${existingAccessory.displayName}`);
        
        // Update accessory name if changed in config
        if (existingAccessory.displayName !== this.deviceName) {
          this.log.info(`🏷 Updating accessory name from "${existingAccessory.displayName}" to "${this.deviceName}"`);
          existingAccessory.displayName = this.deviceName;
        }
        
        // Create HRU accessory with enhanced error handling
        try {
          const hruAccessory = new HRUAccessory(this, existingAccessory);
          this.hruAccessories.push(hruAccessory);
          this.log.info(`✅ Successfully restored accessory: ${existingAccessory.displayName}`);
          accessoryCreated = true; // 🔧 KLÍČOVÁ ZMĚNA
        } catch (error) {
          this.log.error('❌ Failed to create HRU accessory from cache:', error);
          this.log.warn('🔄 Will attempt to create new accessory');
          
          // Remove failed accessory and try creating new one
          const index = this.accessories.indexOf(existingAccessory);
          if (index > -1) {
            this.accessories.splice(index, 1);
          }
          
          // accessoryCreated zůstává false - pokračujeme k vytvoření nového
        }
      } 
      
      // 🔧 OPRAVA: Vytvoř nový pouze pokud nebyl úspěšně obnoven existující
      if (!accessoryCreated) {
        this.log.info(`➕ Adding new accessory: ${this.deviceName}`);
        const accessory = new this.api.platformAccessory(this.deviceName, uuid);
        
        // Enhanced accessory context with more metadata
        accessory.context.device = {
          ip: this.ip,
          port: this.port,
          regimeRegister: this.regimeRegister,
          speedRegister: this.speedRegister,
          deviceName: this.deviceName,
          deviceId: deviceId,
          platformId: this.platformId,
          createdAt: Date.now(),
          version: '2.0.0' // Version for future compatibility checks
        };
        
        try {
          const hruAccessory = new HRUAccessory(this, accessory);
          this.hruAccessories.push(hruAccessory);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.log.info(`✅ Successfully created new accessory: ${this.deviceName}`);
          accessoryCreated = true;
        } catch (error) {
          this.log.error('❌ Failed to create new HRU accessory:', error);
          return;
        }
      }

      const deviceCount = this.hruAccessories.length;
      this.log.info(`🎉 Successfully configured ${deviceCount} ATREA HRU device(s)`);
      
      // Schedule periodic health check
      this.scheduleHealthCheck();
      
      // Log initial connection diagnostics after a delay
      setTimeout(() => {
        this.logConnectionDiagnostics();
      }, 5000);
      
    } catch (error) {
      this.log.error('❌ Error during device discovery:', error);
    }
  }

  private startPlatformDiagnostics(): void {
    // Run detailed diagnostics every 10 minutes
    const diagnosticsTimeout = setInterval(() => {
      if (!this.shutdownInitiated) {
        this.runDetailedDiagnostics();
      }
    }, 600000); // 10 minutes

    this.diagnosticsInterval = diagnosticsTimeout;
    this.timeoutRegistry.add(diagnosticsTimeout);
  }

  private scheduleHealthCheck(): void {
    // Clear existing health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.timeoutRegistry.delete(this.healthCheckInterval);
    }

    // Schedule health check every 5 minutes
    const healthTimeout = setInterval(() => {
      if (!this.shutdownInitiated) {
        this.performHealthCheck();
      }
    }, 300000);

    this.healthCheckInterval = healthTimeout;
    this.timeoutRegistry.add(healthTimeout);
  }

  private performHealthCheck(): void {
    try {
      this.log.debug(`🔍 Performing platform health check for ${this.platformId}...`);
      
      let healthyDevices = 0;
      let totalDevices = this.hruAccessories.length;
      
      // Enhanced health metrics
      const diagnostics: PlatformDiagnostics = {
        totalInstances: HRUAccessory.getInstanceCount(),
        activeConnections: HRUAccessory.getActiveConnections(),
        deviceHealth: [],
        platformHealth: 0,
        anomalies: []
      };
      
      this.hruAccessories.forEach((accessory, index) => {
        try {
          const health = accessory.getConnectionHealth();
          const cacheStats = accessory.getCacheStats();
          const connectionState = accessory.getConnectionState();
          const instanceInfo = accessory.getInstanceInfo();
          
          const deviceDiagnostic = {
            index: index + 1,
            instanceId: instanceInfo.id,
            connectionKey: instanceInfo.connectionKey,
            successRate: health.successRate,
            operations: health.totalOperations,
            consecutiveFailures: health.consecutiveFailures,
            cacheSize: cacheStats.size,
            isConnected: connectionState.isConnected,
            isConnecting: connectionState.isConnecting,
            isCleaningUp: instanceInfo.isCleaningUp
          };
          
          diagnostics.deviceHealth.push(deviceDiagnostic);
          
          this.log.debug(`📊 Device ${index + 1} (${instanceInfo.id.substr(-6)}):`, {
            successRate: `${health.successRate.toFixed(1)}%`,
            operations: health.totalOperations,
            consecutiveFailures: health.consecutiveFailures,
            cacheSize: cacheStats.size,
            connected: connectionState.isConnected
          });
          
          // Criteria for healthy device
          if (health.successRate > 50 && 
              health.consecutiveFailures < 5 && 
              connectionState.isConnected &&
              !instanceInfo.isCleaningUp) {
            healthyDevices++;
          }
        } catch (error) {
          this.log.debug(`❌ Health check failed for device ${index + 1}:`, error);
          diagnostics.anomalies.push(`Device ${index + 1} health check failed: ${error}`);
        }
      });
      
      // Calculate platform health
      if (totalDevices > 0) {
        diagnostics.platformHealth = (healthyDevices / totalDevices) * 100;
        this.log.debug(`💚 Platform health: ${diagnostics.platformHealth.toFixed(1)}% (${healthyDevices}/${totalDevices} devices healthy)`);
        
        if (diagnostics.platformHealth < 50) {
          this.log.warn(`⚠️  Platform health is low: ${diagnostics.platformHealth.toFixed(1)}%`);
          this.consecutiveHealthCheckFailures++;
        } else {
          this.consecutiveHealthCheckFailures = 0;
        }
        
        // Check for critical health failure
        if (this.consecutiveHealthCheckFailures >= 3) {
          this.log.error(`🚨 Critical: Platform health has been low for ${this.consecutiveHealthCheckFailures} consecutive checks`);
        }
      }
      
      // Check for anomalies
      this.detectAnomalies(diagnostics);
      
      // Store diagnostics for trend analysis
      this.lastDiagnostics = diagnostics;
      
    } catch (error) {
      this.log.error('❌ Health check system failure:', error);
      this.consecutiveHealthCheckFailures++;
    }
  }

  private detectAnomalies(diagnostics: PlatformDiagnostics): void {
    // Check instance count consistency
    if (diagnostics.totalInstances !== this.hruAccessories.length) {
      const anomaly = `Instance count mismatch: Platform=${this.hruAccessories.length}, Static=${diagnostics.totalInstances}`;
      diagnostics.anomalies.push(anomaly);
      this.log.warn(`⚠️  ${anomaly}`);
    }
    
    // Check for orphaned connections
    const expectedConnections = this.hruAccessories.map(acc => {
      const info = acc.getInstanceInfo();
      return info.connectionKey;
    });
    
    const unexpectedConnections = diagnostics.activeConnections.filter(
      conn => !expectedConnections.includes(conn)
    );
    
    if (unexpectedConnections.length > 0) {
      const anomaly = `Orphaned connections detected: ${unexpectedConnections.join(', ')}`;
      diagnostics.anomalies.push(anomaly);
      this.log.warn(`⚠️  ${anomaly}`);
    }
    
    // Check for multiple connections to same device
    const connectionCounts = new Map<string, number>();
    diagnostics.activeConnections.forEach(conn => {
      connectionCounts.set(conn, (connectionCounts.get(conn) || 0) + 1);
    });
    
    connectionCounts.forEach((count, conn) => {
      if (count > 1) {
        const anomaly = `Duplicate connections to ${conn}: ${count} instances`;
        diagnostics.anomalies.push(anomaly);
        this.log.error(`🚨 ${anomaly}`);
      }
    });
    
    // Check for devices in permanent connecting state
    diagnostics.deviceHealth.forEach(device => {
      if (device.isConnecting && !device.isConnected) {
        const anomaly = `Device ${device.index} stuck in connecting state`;
        diagnostics.anomalies.push(anomaly);
        this.log.warn(`⚠️  ${anomaly}`);
      }
    });
    
    // Log anomaly summary
    if (diagnostics.anomalies.length > 0) {
      this.log.warn(`🔍 Detected ${diagnostics.anomalies.length} anomal${diagnostics.anomalies.length === 1 ? 'y' : 'ies'}`);
    }
  }

  private runDetailedDiagnostics(): void {
    if (!this.lastDiagnostics) {
      this.log.debug('⭐️  Skipping detailed diagnostics - no baseline data available');
      return;
    }
    
    const uptime = Date.now() - this.platformStartTime;
    const uptimeHours = (uptime / (1000 * 60 * 60)).toFixed(1);
    
    this.log.info('📊 Platform Detailed Diagnostics:');
    this.log.info(`   ⏱️  Platform uptime: ${uptimeHours} hours`);
    this.log.info(`   🔢 Total instances: ${this.lastDiagnostics.totalInstances}`);
    this.log.info(`   🔗 Active connections: ${this.lastDiagnostics.activeConnections.length}`);
    this.log.info(`   💚 Platform health: ${this.lastDiagnostics.platformHealth.toFixed(1)}%`);
    this.log.info(`   📈 Health check failures: ${this.consecutiveHealthCheckFailures}`);
    
    if (this.lastDiagnostics.anomalies.length > 0) {
      this.log.warn('   ⚠️  Active anomalies:');
      this.lastDiagnostics.anomalies.forEach(anomaly => {
        this.log.warn(`      - ${anomaly}`);
      });
    } else {
      this.log.info('   ✅ No anomalies detected');
    }
    
    // Device-specific diagnostics
    this.lastDiagnostics.deviceHealth.forEach(device => {
      this.log.info(`   📱 Device ${device.index} (${device.instanceId.substr(-6)}): ${device.successRate.toFixed(1)}% success, ${device.operations} ops`);
    });
  }

  private logConnectionDiagnostics(): void {
    const instanceCount = HRUAccessory.getInstanceCount();
    const activeConnections = HRUAccessory.getActiveConnections();
    
    this.log.info('🔍 HRU Connection Diagnostics:');
    this.log.info(`   📊 Platform devices: ${this.hruAccessories.length}`);
    this.log.info(`   🔢 Total instances: ${instanceCount}`);
    this.log.info(`   🔗 Active connections: ${activeConnections.length}`);
    
    if (activeConnections.length > 0) {
      this.log.info(`   🌐 Connection endpoints: ${activeConnections.join(', ')}`);
    }
    
    // Warnings for potential issues
    if (instanceCount > this.hruAccessories.length) {
      this.log.warn(`   ⚠️  Instance count (${instanceCount}) > platform devices (${this.hruAccessories.length})`);
    }
    
    if (activeConnections.length > 1) {
      this.log.warn(`   ⚠️  Multiple connections detected - check for duplicate configuration`);
    }
    
    if (instanceCount === 0 && this.hruAccessories.length > 0) {
      this.log.error(`   🚨 No instances but platform has devices - potential initialization failure`);
    }
  }

  // **ENHANCED SHUTDOWN AND CLEANUP**
  
  private async initiateShutdown(): Promise<void> {
    if (this.shutdownInitiated) {
      this.log.debug(`Platform ${this.platformId} shutdown already initiated`);
      return this.cleanupPromise;
    }
    
    this.shutdownInitiated = true;
    this.log.info(`🛑 Initiating graceful shutdown for platform ${this.platformId}...`);
    
    this.cleanupPromise = this.performCleanup();
    return this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    if (this.cleanupHandled) {
      this.log.debug(`Platform ${this.platformId} cleanup already handled`);
      return;
    }
    
    this.cleanupHandled = true;
    this.log.debug(`🧹 Performing platform cleanup for ${this.platformId}...`);
    
    const cleanupStartTime = Date.now();
    
    try {
      // Stop all platform-level intervals
      this.stopPlatformIntervals();
      
      // Get pre-cleanup stats
      const preCleanupStats = {
        devices: this.hruAccessories.length,
        instances: HRUAccessory.getInstanceCount(),
        connections: HRUAccessory.getActiveConnections()
      };
      
      this.log.info(`📊 Pre-cleanup stats: ${preCleanupStats.devices} devices, ${preCleanupStats.instances} instances, ${preCleanupStats.connections.length} connections`);
      
      // Enhanced cleanup with proper coordination
      if (this.hruAccessories.length > 0) {
        this.log.debug(`🔄 Initiating cleanup for ${this.hruAccessories.length} devices...`);
        
        const cleanupPromises = this.hruAccessories.map(async (accessory, index) => {
          try {
            this.log.debug(`🧹 Cleaning up device ${index + 1}/${this.hruAccessories.length}...`);
            await accessory.disconnect();
            this.log.debug(`✅ Device ${index + 1} cleanup completed`);
          } catch (error) {
            this.log.debug(`❌ Error cleaning up device ${index + 1}:`, error);
          }
        });
        
        // 🔧 DOPORUČENÍ: Wait for all individual cleanups with timeout
        await Promise.race([
          Promise.all(cleanupPromises),
          new Promise(resolve => setTimeout(resolve, 12000)) // 12s timeout
        ]);
        
        this.log.debug('✅ All device cleanups initiated');
      }
      
      // Global cleanup of all instances (safety net)
      this.log.debug('🧹 Performing global instance cleanup...');
      
      // 🔧 DOPORUČENÍ: Timeout pro globální cleanup
      await Promise.race([
        HRUAccessory.cleanupAllInstances(),
        new Promise(resolve => setTimeout(resolve, 8000)) // 8s timeout
      ]);
      
      // Clear accessories array
      this.hruAccessories.length = 0;
      
      // Get post-cleanup stats
      const postCleanupStats = {
        instances: HRUAccessory.getInstanceCount(),
        connections: HRUAccessory.getActiveConnections()
      };
      
      const cleanupTime = Date.now() - cleanupStartTime;
      
      this.log.info(`✅ Platform ${this.platformId} cleanup completed in ${cleanupTime}ms`);
      this.log.info(`📊 Post-cleanup stats: ${postCleanupStats.instances} instances, ${postCleanupStats.connections.length} connections`);
      
      // Warn about potential resource leaks
      if (postCleanupStats.instances > 0 || postCleanupStats.connections.length > 0) {
        this.log.warn(`⚠️  Potential resource leak detected:`);
        this.log.warn(`   - Remaining instances: ${postCleanupStats.instances}`);
        this.log.warn(`   - Remaining connections: ${postCleanupStats.connections.length}`);
        
        if (postCleanupStats.connections.length > 0) {
          this.log.warn(`   - Connection keys: ${postCleanupStats.connections.join(', ')}`);
        }
      } else {
        this.log.info('✅ Clean shutdown - no resource leaks detected');
      }
      
    } catch (error) {
      this.log.error(`❌ Error during platform cleanup for ${this.platformId}:`, error);
    }
  }

  private stopPlatformIntervals(): void {
    // Clear health check interval
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.timeoutRegistry.delete(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }
    
    // Clear diagnostics interval
    if (this.diagnosticsInterval) {
      clearInterval(this.diagnosticsInterval);
      this.timeoutRegistry.delete(this.diagnosticsInterval);
      this.diagnosticsInterval = undefined;
    }
    
    // Clear all tracked timeouts
    this.timeoutRegistry.forEach(timeout => clearTimeout(timeout));
    this.timeoutRegistry.clear();
  }

  // **PUBLIC API METHODS**

  /**
   * Get comprehensive platform statistics
   */
  public getPlatformStats(): {
    platformId: string;
    deviceCount: number;
    totalOperations: number;
    averageSuccessRate: number;
    uptime: number;
    instanceCount: number;
    activeConnections: number;
    platformHealth: number;
    anomalyCount: number;
  } {
    const stats = this.hruAccessories.map(accessory => accessory.getConnectionHealth());
    const uptime = Date.now() - this.platformStartTime;
    const activeConnections = HRUAccessory.getActiveConnections();
    
    return {
      platformId: this.platformId,
      deviceCount: this.hruAccessories.length,
      totalOperations: stats.reduce((sum, stat) => sum + stat.totalOperations, 0),
      averageSuccessRate: stats.length > 0 
        ? stats.reduce((sum, stat) => sum + stat.successRate, 0) / stats.length 
        : 0,
      uptime: uptime,
      instanceCount: HRUAccessory.getInstanceCount(),
      activeConnections: activeConnections.length,
      platformHealth: this.lastDiagnostics?.platformHealth || 0,
      anomalyCount: this.lastDiagnostics?.anomalies.length || 0
    };
  }

  /**
   * Force reconnection of all devices
   */
  public async forceReconnectAll(): Promise<void> {
    if (this.shutdownInitiated) {
      throw new Error('Cannot reconnect during shutdown');
    }
    
    this.log.info(`🔄 Force reconnecting all devices for platform ${this.platformId}...`);
    
    const reconnectPromises = this.hruAccessories.map(async (accessory, index) => {
      try {
        this.log.debug(`🔄 Force reconnecting device ${index + 1}...`);
        await accessory.disconnect();
        
        // Staggered reconnection to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, 2000 * index));
        
        this.log.debug(`✅ Device ${index + 1} reconnection initiated`);
      } catch (error) {
        this.log.error(`❌ Error force reconnecting device ${index + 1}:`, error);
      }
    });
    
    await Promise.all(reconnectPromises);
    this.log.info('✅ Force reconnection of all devices completed');
  }

  /**
   * Get current platform diagnostics
   */
  public getCurrentDiagnostics(): PlatformDiagnostics | null {
    return this.lastDiagnostics || null;
  }

  /**
   * Force immediate health check
   */
  public forceHealthCheck(): void {
    if (!this.shutdownInitiated) {
      this.log.info(`🔍 Force health check requested for platform ${this.platformId}`);
      this.performHealthCheck();
    }
  }

  /**
   * Get platform configuration summary
   */
  public getConfigSummary(): Record<string, any> {
    return {
      platformId: this.platformId,
      ip: this.ip,
      port: this.port,
      regimeRegister: this.regimeRegister,
      speedRegister: this.speedRegister,
      deviceName: this.deviceName,
      connectionTimeout: this.connectionTimeout,
      operationThrottle: this.operationThrottle,
      maxRetries: this.maxRetries,
      heartbeatInterval: this.heartbeatInterval,
      cacheTimeout: this.cacheTimeout,
      configValidationErrors: this.configValidationErrors.length,
      shutdownInitiated: this.shutdownInitiated
    };
  }
}