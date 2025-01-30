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

// Helper function to convert day index to date string
function getDayDate(dayIndex, seasonYear) {
    const date = new Date(seasonYear, 7, 1); // Month is 0-based, so 7 is August
    date.setDate(date.getDate() + dayIndex);
    return date.toLocaleDateString('en-US', { 
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

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

// Interpolate snow depth values (matching MATLAB implementation)
function interpolateSnowDepth(depths) {
    // Create a copy of the input array
    depths = [...depths];
    
    // Find gaps in the data (equivalent to isnan in MATLAB)
    const gaps = depths.map(d => d === null || isNaN(d) || d === -9999);
    
    // If no gaps, return original array
    if (!gaps.some(g => g)) {
        return depths;
    }
    
    // Find valid values at start and end (equivalent to find(~gaps, 1, 'first/last'))
    const first_valid = gaps.findIndex(g => !g);
    const last_valid = gaps.length - 1 - [...gaps].reverse().findIndex(g => !g);
    
    if (first_valid === -1 || last_valid === -1) {
        return depths;
    }
    
    // Get indices of valid measurements
    const valid_indices = [];
    const valid_values = [];
    for (let i = 0; i < depths.length; i++) {
        if (!gaps[i]) {
            valid_indices.push(i);
            valid_values.push(depths[i]);
        }
    }
    
    // Create interpolation for gaps between valid measurements
    const gap_indices = [];
    for (let i = 0; i < gaps.length; i++) {
        if (gaps[i] && i > first_valid && i < last_valid) {
            gap_indices.push(i);
        }
    }
    
    if (gap_indices.length > 0) {
        // Implement linear interpolation (equivalent to interp1 with 'linear' method)
        gap_indices.forEach(gap_idx => {
            // Find the surrounding valid points
            const prev_idx = valid_indices.filter(idx => idx < gap_idx).pop();
            const next_idx = valid_indices.find(idx => idx > gap_idx);
            
            if (prev_idx !== undefined && next_idx !== undefined) {
                const prev_value = depths[prev_idx];
                const next_value = depths[next_idx];
                const fraction = (gap_idx - prev_idx) / (next_idx - prev_idx);
                depths[gap_idx] = prev_value + (next_value - prev_value) * fraction;
            }
        });
    }
    
    return depths;
}

// Process seasons
function processSeasons(rawData) {
    // Clean and convert data
    const cleanData = rawData.map(row => ({
        date: new Date(row.DATE),
        depth: row.SNWD === -9999 || row.SNWD === null ? null : row.SNWD / 25.4,  // Convert mm to inches
        snowfall: row.SNOW === -9999 || row.SNOW === null ? 0 : row.SNOW / 25.4   // Missing snowfall treated as 0
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
                cumulative: new Array(365).fill(0),  // Initialize cumulative to 0
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
        // Find the last valid date for current season
        const lastValidIndex = data.isCurrent ? 
            data.dates.reduce((acc, date, idx) => date ? idx : acc, -1) : 
            364;

        // Get all depths up to last valid index
        let seasonDepths = data.depths.slice(0, lastValidIndex + 1);
        
        // Interpolate depths
        let interpolatedDepths = interpolateSnowDepth(seasonDepths);

        // For current season, pad with nulls after last valid index
        if (data.isCurrent && lastValidIndex < 364) {
            interpolatedDepths = [
                ...interpolatedDepths,
                ...new Array(364 - lastValidIndex).fill(null)
            ];
        }

        // Calculate cumulative snowfall
        let cumulativeSnow = 0;
        const cumulative = data.cumulative.map((dailySnow, idx) => {
            if (data.isCurrent && idx > lastValidIndex) {
                return null;  // Only use null after the last valid date for current season
            }
            cumulativeSnow += dailySnow;  // dailySnow is already 0 if it was missing
            return cumulativeSnow;
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

// Create the base charts
function createBaseCharts() {
    ['depthChart', 'cumulativeChart'].forEach(chartId => {
        const isDepth = chartId === 'depthChart';
        const traces = [];

        const currentYear = new Date().getFullYear();
        const customdata = Array.from({length: 365}, (_, i) => getDayDate(i, currentYear));

        // Add background traces first
        seasonsData.forEach(season => {
            if (!season.isCurrent) {
                traces.push({
                    x: [...Array(365).keys()],
                    y: isDepth ? season.depths : season.cumulative,
                    customdata: customdata,
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
            customdata: customdata,
            name: 'Average',
            line: { color: '#FF0000', width: 2 },  // Changed to red
            hovertemplate: '%{customdata}<br>Average : %{y:.1f}<extra></extra>'
        });

        Plotly.newPlot(chartId, traces, createLayout(
            isDepth ? 'Snow Depth' : 'Cumulative Snowfall',
            isDepth ? 'Snow Depth (inches)' : 'Cumulative Snowfall (inches)'
        ));
    });
}

// Create layout for charts
function createLayout(title, yTitle, seasonStartYear) {
    const year = seasonStartYear || new Date().getFullYear();
    return {
        title: {
            text: title,
            font: {
                color: 'white'
            }
        },
        xaxis: {
            tickvals: [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334],
            ticktext: ['Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'],
            title: {
                text: 'Month',
                font: {
                    color: 'white'  // Make x-axis label white
                }
            },
            tickfont: {
                color: 'white'  // Make tick labels white
            }
        },
        yaxis: { 
            title: {
                text: yTitle,
                font: {
                    color: 'white'  // Make y-axis label white
                }
            },
            tickfont: {
                color: 'white'  // Make tick labels white
            },
            hoverformat: '.1f',
            gridcolor: 'rgba(255, 255, 255, 0.1)'  // Lighter grid lines
        },
        plot_bgcolor: 'rgba(0,0,0,0)',  // Transparent plot background
        paper_bgcolor: 'rgba(0,0,0,0)',  // Transparent paper background
        hovermode: 'x unified',
        showlegend: true,
        legend: {
            font: {
                color: 'white'  // Make legend text white
            }
        },
        margin: { t: 40, b: 60 },
        hoverlabel: {
            namelength: -1
        }
    };
}


// Update highlighted season
function updateHighlightedSeason(seasonName) {
    const season = seasonsData.find(s => s.name === seasonName);
    if (!season) return;
    
    ['depthChart', 'cumulativeChart'].forEach(chartId => {
        const isDepth = chartId === 'depthChart';
        const traces = [];

        // Get the season start year from the season name
        const [seasonStartYear] = season.name.split('-').map(Number);
        const customdata = Array.from({length: 365}, (_, i) => getDayDate(i, seasonStartYear));

        // Add background traces first
        seasonsData.forEach(s => {
            if (!s.isCurrent) {
                traces.push({
                    x: [...Array(365).keys()],
                    y: isDepth ? s.depths : s.cumulative,
                    customdata: customdata,
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
            customdata: customdata,
            name: 'Average',
            line: { color: '#ffffff', width: 2 },  // Changed to red
            hovertemplate: '%{customdata}<br>Average : %{y:.1f}<extra></extra>'
        });

        // Add selected season trace
        traces.push({
            x: [...Array(365).keys()],
            y: isDepth ? season.depths : season.cumulative,
            customdata: customdata,
            name: season.name,
            line: { color: '#2387fa', width: 3 },  // Changed to bright blue
            hovertemplate: `%{customdata}<br>${season.name} : %{y:.1f}<extra></extra>`
        });

        Plotly.newPlot(chartId, traces, createLayout(
            isDepth ? 'Snow Depth' : 'Cumulative Snowfall',
            isDepth ? 'Snow Depth (inches)' : 'Cumulative Snowfall (inches)',
            seasonStartYear
        ));
    });
}

// Populate season selector
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