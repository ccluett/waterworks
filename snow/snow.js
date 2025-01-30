const { useState, useEffect } = React;
const {
    LineChart,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    Legend,
    ResponsiveContainer
} = Recharts;

const SnowVisualization = () => {
    const [snowData, setSnowData] = useState({ current: [], average: [] });
    const [loading, setLoading] = useState(true);

    // Updated interpolation function without modern operators
    const interpolateSnowDepth = (depths) => {
        const interpolated = [...depths];
        let startIdx = -1;

        // Find first non-null value
        for (let i = 0; i < interpolated.length; i++) {
            if (interpolated[i] !== null) {
                startIdx = i;
                break;
            }
        }

        // Find last non-null value
        let endIdx = -1;
        for (let i = interpolated.length - 1; i >= 0; i--) {
            if (interpolated[i] !== null) {
                endIdx = i;
                break;
            }
        }

        if (startIdx === -1 || endIdx === -1) return interpolated;

        // Linear interpolation
        let prevVal = interpolated[startIdx];
        let prevIdx = startIdx;

        for (let i = startIdx + 1; i <= endIdx; i++) {
            if (interpolated[i] === null) {
                let nextIdx = i;
                while (nextIdx <= endIdx && interpolated[nextIdx] === null) {
                    nextIdx++;
                }
                if (nextIdx > endIdx) break;
                
                const slope = (interpolated[nextIdx] - prevVal) / (nextIdx - prevIdx);
                for (let j = prevIdx + 1; j < nextIdx; j++) {
                    interpolated[j] = prevVal + slope * (j - prevIdx);
                }
                prevVal = interpolated[nextIdx];
                prevIdx = nextIdx;
                i = nextIdx;
            } else {
                prevVal = interpolated[i];
                prevIdx = i;
            }
        }

        return interpolated;
    };

    // Updated data processing with compatible syntax
    const processSnowData = (rawData) => {
        const cleanData = rawData.map(row => ({
            date: new Date(row.DATE),
            snowDepth: row.SNWD === -9999 ? null : row.SNWD / 25.4,
            snowfall: row.SNOW === -9999 ? 0 : row.SNOW / 25.4
        }));

        const seasonData = {};
        const currentYear = new Date().getFullYear();
        const currentMonth = new Date().getMonth();
        const currentSeason = currentMonth >= 7 ? 
            `${currentYear}-${currentYear + 1}` : 
            `${currentYear - 1}-${currentYear}`;

        cleanData.forEach(row => {
            const month = row.date.getMonth();
            const year = row.date.getFullYear();
            const seasonStart = month >= 7 ? year : year - 1;
            const seasonKey = `${seasonStart}-${seasonStart + 1}`;
            
            if (row.date > new Date()) return;

            const seasonStartDate = new Date(seasonStart, 7, 1);
            const dayIndex = Math.floor((row.date - seasonStartDate) / (1000 * 60 * 60 * 24));
            
            if (dayIndex >= 0 && dayIndex < 365) {
                if (!seasonData[seasonKey]) {
                    seasonData[seasonKey] = Array(365).fill().map(() => ({
                        snowDepth: null,
                        snowfall: null,
                        date: null
                    }));
                }

                seasonData[seasonKey][dayIndex] = {
                    snowDepth: row.snowDepth,
                    snowfall: row.snowfall,
                    date: row.date
                };
            }
        });

        const seasonTotals = [];
        Object.keys(seasonData).forEach(seasonKey => {
            if (seasonKey !== currentSeason) {
                const depths = seasonData[seasonKey].map(d => 
                    d && d.snowDepth !== null ? d.snowDepth : null
                );
                const interpolatedDepths = interpolateSnowDepth(depths);
                
                let cumulative = 0;
                const cumulativeSnow = seasonData[seasonKey].map((d, idx) => {
                    if (d && d.snowfall) cumulative += d.snowfall;
                    return cumulative;
                });

                seasonTotals.push({
                    depths: interpolatedDepths,
                    cumulative: cumulativeSnow
                });
            }
        });

        // Average calculation remains the same
        const averageDepth = Array(365).fill(null);
        const averageCumulative = Array(365).fill(null);
        
        for (let i = 0; i < 365; i++) {
            let depthSum = 0;
            let depthCount = 0;
            let cumSum = 0;
            let cumCount = 0;

            seasonTotals.forEach(season => {
                if (season.depths[i] !== null) {
                    depthSum += season.depths[i];
                    depthCount++;
                }
                if (season.cumulative[i] !== null) {
                    cumSum += season.cumulative[i];
                    cumCount++;
                }
            });

            averageDepth[i] = depthCount > 0 ? depthSum / depthCount : null;
            averageCumulative[i] = cumCount > 0 ? cumSum / cumCount : null;
        }

        const currentDepths = (seasonData[currentSeason] || []).map(d => 
            d && d.snowDepth !== null ? d.snowDepth : null
        );
        const interpolatedCurrentDepths = interpolateSnowDepth(currentDepths);
        
        let currentCumulativeSnow = 0;
        const currentData = [];
        if (seasonData[currentSeason]) {
            seasonData[currentSeason].forEach((day, idx) => {
                if (day && day.date) {
                    if (day.snowfall) currentCumulativeSnow += day.snowfall;
                    currentData.push({
                        dayIndex: idx,
                        snowDepth: interpolatedCurrentDepths[idx],
                        cumulativeSnow: currentCumulativeSnow,
                        date: new Date(2000, 7, 1 + idx)
                    });
                }
            });
        }

        const averageData = [];
        for (let i = 0; i < 365; i++) {
            averageData.push({
                dayIndex: i,
                snowDepth: averageDepth[i],
                cumulativeSnow: averageCumulative[i],
                date: new Date(2000, 7, 1 + i)
            });
        }

        return {
            current: currentData,
            average: averageData
        };
    };

    // Keep the rest of the component code the same
    // ... [remaining useEffect and JSX code] ...
};

const root = ReactDOM.createRoot(document.getElementById('snow-visualization'));
root.render(<SnowVisualization />);