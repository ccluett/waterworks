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

    const interpolateSnowDepth = (depths) => {
        const interpolated = [...depths];
        let startIdx = -1;

        for (let i = 0; i < interpolated.length; i++) {
            if (interpolated[i] !== null) {
                startIdx = i;
                break;
            }
        }

        let endIdx = -1;
        for (let i = interpolated.length - 1; i >= 0; i--) {
            if (interpolated[i] !== null) {
                endIdx = i;
                break;
            }
        }

        if (startIdx === -1 || endIdx === -1) return interpolated;

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
                    seasonData[seasonKey] = new Array(365).fill(null).map(() => ({
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
                // Fix for optional chaining operator
                const depths = seasonData[seasonKey].map(d => (d && d.snowDepth) || null);
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

        const averageDepth = new Array(365).fill(null);
        const averageCumulative = new Array(365).fill(null);
        
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

        // Fix for optional chaining operator
        const currentDepths = (seasonData[currentSeason] || []).map(d => (d && d.snowDepth) || null);
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

    useEffect(() => {
        const fetchData = async () => {
            try {
                const response = await fetch(
                    'https://www.ncei.noaa.gov/access/services/data/v1?' +
                    'dataset=daily-summaries&' +
                    'stations=USW00014755&' +
                    'dataTypes=SNOW,SNWD&' +
                    'startDate=1950-01-01&' +
                    'endDate=' + new Date().toISOString().split('T')[0] + '&' +
                    'format=csv'
                );
                
                const text = await response.text();
                
                Papa.parse(text, {
                    header: true,
                    dynamicTyping: true,
                    skipEmptyLines: true,
                    complete: (results) => {
                        const processed = processSnowData(results.data);
                        console.log('Processed data:', processed);
                        setSnowData(processed);
                        setLoading(false);
                    }
                });
            } catch (error) {
                console.error('Error fetching data:', error);
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const dayIndex = payload[0].payload.dayIndex;
            const date = new Date(2000, 7, 1 + (dayIndex || 0));
            const value = payload[0].value;
            const dataType = payload[0].dataKey === 'snowDepth' ? 'Snow Depth' : 'Cumulative Snowfall';
            
            return (
                <div className="custom-tooltip">
                    <p>{date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</p>
                    <p>{`${dataType}: ${value ? value.toFixed(1) : 'N/A'} inches`}</p>
                </div>
            );
        }
        return null;
    };

    if (loading) {
        return <div className="loading">Loading snow data...</div>;
    }

    return (
        <div className="snow-charts">
            <div className="chart-container">
                <h2>Snow Depth</h2>
                <ResponsiveContainer width="100%" height={400}>
                    <LineChart>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis 
                            dataKey="dayIndex"
                            type="number"
                            domain={[0, 364]}
                            tickFormatter={(index) => {
                                const date = new Date(2000, 7, 1 + index);
                                return date.toLocaleDateString('en-US', { month: 'short' });
                            }}
                            ticks={[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]}
                        />
                        <YAxis
                            label={{ value: 'Snow Depth (inches)', angle: -90, position: 'insideLeft' }}
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend />
                        <Line
                            data={snowData.average}
                            dataKey="snowDepth"
                            stroke="#000"
                            strokeWidth={2}
                            dot={false}
                            name="Average"
                        />
                        <Line
                            data={snowData.current}
                            dataKey="snowDepth"
                            stroke="#0066cc"
                            strokeWidth={2}
                            dot={false}
                            name="Current Season"
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>

            <div className="chart-container">
                <h2>Cumulative Snowfall</h2>
                <ResponsiveContainer width="100%" height={400}>
                    <LineChart>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis 
                            dataKey="dayIndex"
                            type="number"
                            domain={[0, 364]}
                            tickFormatter={(index) => {
                                const date = new Date(2000, 7, 1 + index);
                                return date.toLocaleDateString('en-US', { month: 'short' });
                            }}
                            ticks={[0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]}
                        />
                        <YAxis
                            label={{ value: 'Cumulative Snowfall (inches)', angle: -90, position: 'insideLeft' }}
                        />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend />
                        <Line
                            data={snowData.average}
                            dataKey="cumulativeSnow"
                            stroke="#000"
                            strokeWidth={2}
                            dot={false}
                            name="Average"
                        />
                        <Line
                            data={snowData.current}
                            dataKey="cumulativeSnow"
                            stroke="#00994c"
                            strokeWidth={2}
                            dot={false}
                            name="Current Season"
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
};

const root = ReactDOM.createRoot(document.getElementById('snow-visualization'));
root.render(<SnowVisualization />);