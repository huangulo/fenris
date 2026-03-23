import { Metric, AnomalyDetectionResult, Config } from '../types.js';

export class AnomalyDetector {
  private metricsHistory: Map<string, number[]> = new Map();
  private config: Config['anomaly_detection'];
  
  constructor(config: Config['anomaly_detection']) {
    this.config = config;
  }

  /**
   * Detect anomalies using Z-score algorithm
   * Z-score measures how many standard deviations a value is from the mean
   * Higher Z-score = more unusual (anomaly)
   */
  detectAnomaly(metricType: string, currentValue: number): AnomalyDetectionResult {
    const history = this.metricsHistory.get(metricType);
    
    // Need minimum samples before detecting
    if (!history || history.length < this.config.min_samples) {
      return {
        isAnomaly: false,
        zScore: 0,
        mean: currentValue,
        stdDev: 0,
        threshold: this.config.zscore_threshold
      };
    }
    
    // Use sliding window of last N samples
    const window = history.slice(-this.config.window_size);
    
    // Calculate mean
    const sum = window.reduce((a, b) => a + b, 0);
    const mean = sum / window.length;
    
    // Calculate standard deviation
    const squaredDiffs = window.map(x => Math.pow(x - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / window.length;
    const stdDev = Math.sqrt(variance);
    
    // Avoid division by zero
    if (stdDev === 0) {
      return {
        isAnomaly: false,
        zScore: 0,
        mean,
        stdDev,
        threshold: this.config.zscore_threshold
      };
    }
    
    // Calculate Z-score
    const zScore = (currentValue - mean) / stdDev;
    const isAnomaly = Math.abs(zScore) > this.config.zscore_threshold;
    
    return {
      isAnomaly,
      zScore,
      mean,
      stdDev,
      threshold: this.config.zscore_threshold
    };
  }

  /**
   * Add metric to history
   */
  addMetric(metricType: string, value: number): void {
    if (!this.metricsHistory.has(metricType)) {
      this.metricsHistory.set(metricType, []);
    }
    
    const history = this.metricsHistory.get(metricType)!;
    history.push(value);
    
    // Keep only last window_size * 2 samples to prevent memory growth
    const maxSamples = this.config.window_size * 2;
    if (history.length > maxSamples) {
      history.splice(0, history.length - maxSamples);
    }
  }

  /**
   * Get history for debugging
   */
  getHistory(metricType: string): number[] {
    return this.metricsHistory.get(metricType) || [];
  }

  /**
   * Clear history (useful for testing or re-baselining)
   */
  clearHistory(metricType?: string): void {
    if (metricType) {
      this.metricsHistory.delete(metricType);
    } else {
      this.metricsHistory.clear();
    }
  }

  /**
   * Detect anomalies from multiple metrics
   */
  detectBatch(metricValues: Map<string, number>): Map<string, AnomalyDetectionResult> {
    const results = new Map<string, AnomalyDetectionResult>();
    
    for (const [metricType, value] of metricValues.entries()) {
      this.addMetric(metricType, value);
      const result = this.detectAnomaly(metricType, value);
      results.set(metricType, result);
    }
    
    return results;
  }
}
