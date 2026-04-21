import React, { useEffect, useRef } from 'react';
import { createChart } from 'lightweight-charts';

const Chart = ({ latestPrice, latestTime }) => { // 🚀 Accept time from socket!
  const chartContainerRef = useRef();
  const chartRef = useRef();
  const lineSeriesRef = useRef();

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { 
        background: { color: 'transparent' }, // Makes it blend into your UI
        textColor: '#d1d4dc' 
      },
      grid: { 
        vertLines: { visible: false }, // Hide grid for a cleaner "Mini" look
        horzLines: { color: '#2B2B43' } 
      },
      width: chartContainerRef.current.clientWidth,
      height: 200, // Usually mini-charts are shorter
      handleScale: false, // Prevents users from accidentally zooming in
      handleScroll: false,
    });

    const lineSeries = chart.addAreaSeries({
      lineColor: '#2962ff',
      topColor: 'rgba(41, 98, 255, 0.3)',
      bottomColor: 'rgba(41, 98, 255, 0)',
      lineWidth: 2,
    });

    chartRef.current = chart;
    lineSeriesRef.current = lineSeries;

    // 🚀 Resize Listener (Fixes the layout on mobile/resize)
    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // Update logic
  useEffect(() => {
    if (latestPrice && lineSeriesRef.current) {
      lineSeriesRef.current.update({
        // 🚀 Using the socket time ensures the data is always in order
        time: latestTime || Math.floor(Date.now() / 1000), 
        value: parseFloat(latestPrice),
      });
    }
  }, [latestPrice, latestTime]);

  return <div ref={chartContainerRef} className="w-full h-[200px]" />;
};

export default Chart;