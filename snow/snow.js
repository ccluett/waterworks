// Configuration and State
const config = {
    station: 'USW00014755',
    startDate: '1950-01-01',
    endDate: new Date().toISOString().split('T')[0],
    dataTypes: 'SNOW,SNWD'
};

let seasonsData = [];
let averageData = { depths: [], cumulative: [] };
let currentSeason = '';

// Data Fetching Function
async function fetchData() {
    const url = new URL('https://www.ncei.noaa.gov/access/services/data/v1');
    url.searchParams.set('dataset', 'daily-summaries');
    url.searchParams.set('stations', config.station);
    url.searchParams.set('dataTypes', config.dataTypes);
    url.searchParams.set('startDate', config.startDate);
    url.searchParams.set('endDate', config.endDate);
    url.searchParams.set('format', 'csv');

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const text = await response.text();
        
        return new Promise((resolve) => {
            Papa.parse(text, {
                header: true,
                dynamicTyping: true,
                complete: (results) => {
                    resolve(results.data.filter(row => row.DATE));
                }
            });
        });
    } catch (error) {
        console.error('Data fetch failed:', error);
        return [];
    }
}

// Helper function to interpolate missing snow depth values
function interpolateSnowDepth(depths) {
    // Find valid values and their indices
    const validIndices = [];
    const validValues = [];
    for (let i = 0; i < depths.length; i++) {
        if (depths[i] !== null && !isNaN(depths[i])) {
            validIndices.push(i);
            validValues.push(depths[i]);
        }
    }

    if (validIndices.length < 2) return depths;

    // Interpolate between valid values
    const result = [...depths];
    for (let i = 0; i < validIndices.length - 1; i++) {
        const start = validIndices[i];
        const end = validIndices[i + 1];
        const startVal = validValues[i];
        const endVal = validValues[i + 1];

        for (let j = start + 1; j < end; j++) {
            const fraction = (j - start) / (end - start);
            result[j] = startVal + (endVal - startVal) * fraction;
        }
    }

    return result;
}

// Process seasons (aligned with MATLAB process_daily_seasons function)
function processSeasons(rawData) {
    // Clean and convert data
    const cleanData = rawData.map(row => ({
        date: new Date(row.DATE),
        depth: row.SNWD === -9999 ? null : row.SNWD / 25.4, // Convert mm to inches
        snowfall: row.SNOW === -9999 ? 0 : row.SNOW / 25.4  // Convert mm to inches
    })).filter(row => row.date && !isNaN(row.date.getTime()));

    // Determine current season
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();
    currentSeason = currentMonth >= 7 ? 
        `${currentYear}-${currentYear + 1}` : 
        `${currentYear - 1}-${currentYear}`;

    // Initialize season containers
    const seasons = {};
    cleanData.forEach(row => {
        const year = row.date.getMonth() >= 7 ? 
            row.date.getFullYear() : 
            row.date.getFullYear() - 1;
        const seasonKey = `${year}-${year + 1}`;
        
        if (!seasons[seasonKey]) {
            seasons[seasonKey] = {
                depths: new Array(365).fill(null),
                cumulative: new Array(365).fill(0),
                dates: new Array(365).fill(null),
                isCurrent: seasonKey === currentSeason
            };
        }

        // Calculate day index (Aug 1 = 0)
        const seasonStart = new Date(year, 7, 1); // August 1st
        const dayIndex = Math.floor((row.date - seasonStart) / (24 * 60 * 60 * 1000));
        
        if (dayIndex >= 0 && dayIndex < 365) {
            seasons[seasonKey].depths[dayIndex] = row.depth;
            seasons[seasonKey].cumulative[dayIndex] = row.snowfall;
            seasons[seasonKey].dates[dayIndex] = row.date;
        }
    });

    // Process each season
    seasonsData = Object.entries(seasons).map(([season, data]) => {
        // Interpolate depths
        let interpolatedDepths = interpolateSnowDepth([...data.depths]);
        
        // Calculate cumulative snowfall
        let cumulativeSnow = 0;
        const cumulative = data.cumulative.map((dailySnow, idx) => {
            if (data.dates[idx]) {
                cumulativeSnow += dailySnow;
                return cumulativeSnow;
            }
            return data.isCurrent ? null : cumulativeSnow;
        });

        return {
            name: season,
            depths: interpolatedDepths,
            cumulative: cumulative,
            isCurrent: data.isCurrent
        };
    });

    // Sort seasons chronologically
    seasonsData.sort((a, b) => a.name.localeCompare(b.name));

    // Calculate averages (excluding current season)
    const validSeasons = seasonsData.filter(s => !s.isCurrent);
    averageData = {
        depths: calculateAverage(validSeasons.map(s => s.depths)),
        cumulative: calculateAverage(validSeasons.map(s => s.cumulative))
    };
}

// Calculate average across seasons
function calculateAverage(arrays) {
    return Array.from({length: 365}, (_, i) => {
        const values = arrays.map(a => a[i]).filter(v => v !== null && !isNaN(v));
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    });
}

// Main initialization
(async function init() {
    try {
        const rawData = await fetchData();
        processSeasons(rawData);
        createBaseCharts();
        populateSeasonSelector();
        
        // Initialize with the most recent season
        if (seasonsData.length > 0) {
            const selector = document.getElementById('seasonSelector');
            selector.value = seasonsData[seasonsData.length - 1].name;
            updateHighlightedSeason(seasonsData[seasonsData.length - 1].name);
        }
    } catch (error) {
        console.error('Initialization failed:', error);
    }
})();

function createBaseCharts() {
    ['depthChart', 'cumulativeChart'].forEach(chartId => {
        const isDepth = chartId === 'depthChart';
        const traces = [];

        // Add background traces first
        seasonsData.forEach(season => {
            if (!season.isCurrent) {
                traces.push({
                    x: [...Array(365).keys()],
                    y: isDepth ? season.depths : season.cumulative,
                    line: { color: 'rgba(200,200,200,0.2)', width: 1 },
                    hoverinfo: 'none',
                    showlegend: false
                });
            }
        });

        // Add average trace last
        traces.push({
            x: [...Array(365).keys()],
            y: isDepth ? averageData.depths : averageData.cumulative,
            name: 'Average',
            line: { color: '#000', width: 2 }
        });

        Plotly.newPlot(chartId, traces, {
            ...createLayout(
                isDepth ? 'Snow Depth' : 'Cumulative Snowfall',
                isDepth ? 'Snow Depth (inches)' : 'Cumulative Snowfall (inches)'
            )
        });
    });
}

function createLayout(title, yTitle) {
    return {
        title: title,
        xaxis: {
            tickvals: [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334],
            ticktext: ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
            title: 'Month'
        },
        yaxis: { 
            title: yTitle,
            hoverformat: '.1f'
        },
        hovermode: 'x unified',
        showlegend: true,
        margin: { t: 40, b: 60 }
    };
}

function updateHighlightedSeason(seasonName) {
    const season = seasonsData.find(s => s.name === seasonName);
    if (!season) return;
    
    // Update both charts
    ['depthChart', 'cumulativeChart'].forEach(chartId => {
        const isDepth = chartId === 'depthChart';
        const traces = [];

        // Add background traces first
        seasonsData.forEach(s => {
            if (!s.isCurrent) {
                traces.push({
                    x: [...Array(365).keys()],
                    y: isDepth ? s.depths : s.cumulative,
                    line: { color: 'rgba(200,200,200,0.2)', width: 1 },
                    hoverinfo: 'none',
                    showlegend: false
                });
            }
        });

        // Add average trace
        traces.push({
            x: [...Array(365).keys()],
            y: isDepth ? averageData.depths : averageData.cumulative,
            name: 'Average',
            line: { color: '#000', width: 2 }
        });

        // Add selected season trace
        traces.push({
            x: [...Array(365).keys()],
            y: isDepth ? season.depths : season.cumulative,
            name: season.name,
            line: { color: '#0066cc', width: 2 }
        });

        Plotly.newPlot(chartId, traces, {
            ...createLayout(
                isDepth ? 'Snow Depth' : 'Cumulative Snowfall',
                isDepth ? 'Snow Depth (inches)' : 'Cumulative Snowfall (inches)'
            )
        });
    });
}

function populateSeasonSelector() {
    const selector = document.getElementById('seasonSelector');
    selector.innerHTML = ''; // Clear existing options
    
    // Add average option
    const avgOption = document.createElement('option');
    avgOption.value = 'average';
    avgOption.textContent = 'Average';
    selector.appendChild(avgOption);
    
    // Add season options
    seasonsData.forEach(season => {
        const option = document.createElement('option');
        option.value = season.name;
        option.textContent = season.name;
        selector.appendChild(option);
    });

    // Set up event listener
    selector.addEventListener('change', function() {
        if (this.value === 'average') {
            createBaseCharts();
        } else {
            updateHighlightedSeason(this.value);
        }
    });
}