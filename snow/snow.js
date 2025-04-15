// Configuration and State
const config = {
    station: 'USW00014755',
    startDate: '1948-08-01',
    endDate: new Date().toISOString().split('T')[0],
    dataTypes: 'SNOW,SNWD'
};

let seasonsData = [];
let averageData = { depths: [], cumulative: [] };
let currentSeason = '';

// Convert day index to date string
function getDayDate(dayIndex, seasonYear) {
    const date = new Date(seasonYear, 7, 1); // Month is 0-based
    date.setDate(date.getDate() + dayIndex);
    return date.toLocaleDateString('en-US', { 
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

// Data Fetching
async function fetchData() {
    const baseUrl = 'https://www.ncdc.noaa.gov/cdo-web/api/v2/data';
    const token = 'nXmOKjrZlqFObwTYdKyPRurnbZhVvTZz';
    
    // Create an abort controller for timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    async function fetchDataTypeByYear(dataType, startYear, endYear) {
        console.log(`Fetching ${dataType} data for years ${startYear}-${endYear}`);
        
        // Create date range for this batch
        const startDate = startYear === parseInt(config.startDate.split('-')[0]) ? 
            config.startDate : 
            `${startYear}-01-01`;
            
        const endDate = endYear === parseInt(config.endDate.split('-')[0]) ?
            config.endDate :
            `${endYear}-12-31`;
            
        const params = new URLSearchParams();
        params.set('datasetid', 'GHCND');
        params.set('stationid', 'GHCND:' + config.station);
        params.set('startdate', startDate);
        params.set('enddate', endDate);
        params.set('limit', '1000');
        params.set('units', 'standard');
        params.set('datatypeid', dataType);
        
        let typeData = [];
        let offset = 0;
        let moreData = true;
        
        while (moreData) {
            const queryParams = new URLSearchParams(params);
            queryParams.set('offset', offset.toString());
            const url = `${baseUrl}?${queryParams.toString()}`;
            
            console.log(`Fetching ${dataType} from: ${url}`);
            
            const response = await fetch(url, {
                signal: controller.signal,
                cache: 'no-cache',
                headers: {
                    'token': token
                }
            });
            
            if (!response.ok) {
                console.error(`Error fetching ${dataType} data for years ${startYear}-${endYear}: ${response.status}`);
                return [];
            }
            
            const data = await response.json();
            
            if (!data.results || data.results.length === 0) {
                break;
            }
            
            console.log(`Received ${data.results.length} ${dataType} records for ${startYear}-${endYear}`);
            typeData = [...typeData, ...data.results];
            offset += data.results.length;
            
            if (data.metadata && data.metadata.resultset) {
                const { count, limit, offset: currentOffset } = data.metadata.resultset;
                if (currentOffset + limit >= count) {
                    moreData = false;
                }
            } else {
                moreData = false;
            }
        }
        
        return typeData;
    }

    try {
        // Fetch each data type separately, similar to the MATLAB approach
        let snowData = [];
        let snowDepthData = [];
        
        // Get the start and end years from config
        const startYear = parseInt(config.startDate.split('-')[0]);
        const endYear = parseInt(config.endDate.split('-')[0]);
        
        // Fetch data in year batches
        for (let year = startYear; year <= endYear; year++) {
            // Fetch SNOW data for this year
            const yearSnowData = await fetchDataTypeByYear('SNOW', year, year);
            snowData = [...snowData, ...yearSnowData];
            
            // Fetch SNWD data for this year
            const yearSnwdData = await fetchDataTypeByYear('SNWD', year, year);
            snowDepthData = [...snowDepthData, ...yearSnwdData];
        }
        
        // Check if we got any data
        console.log(`Retrieved ${snowData.length} SNOW records and ${snowDepthData.length} SNWD records`);
        
        if (snowData.length === 0 && snowDepthData.length === 0) {
            console.warn('No data returned from API');
            throw new Error('No data returned from API');
        }
        
        // Log sample data if available
        if (snowData.length > 0) {
            console.log('Sample SNOW data:', snowData[0]);
        }
        if (snowDepthData.length > 0) {
            console.log('Sample SNWD data:', snowDepthData[0]);
        }
        
        // Combine the data (similar to MATLAB's approach)
        const dataByDate = {};
        
        // Process snow data
        snowData.forEach(item => {
            if (!item.date || !item.value) return;
            
            const date = item.date.split('T')[0]; // Extract date part
            if (!dataByDate[date]) {
                dataByDate[date] = { DATE: date, SNOW: -9999, SNWD: -9999 };
            }
            
            dataByDate[date].SNOW = parseFloat(item.value);
        });
        
        // Process snow depth data
        snowDepthData.forEach(item => {
            if (!item.date || !item.value) return;
            
            const date = item.date.split('T')[0]; // Extract date part
            if (!dataByDate[date]) {
                dataByDate[date] = { DATE: date, SNOW: -9999, SNWD: -9999 };
            }
            
            dataByDate[date].SNWD = parseFloat(item.value);
        });
        
        // Convert to array of objects for compatibility with the existing code
        const formattedData = Object.values(dataByDate).filter(row => row.DATE);
        
        console.log(`Combined data into ${formattedData.length} daily records`);
        
        return formattedData;
    } catch (error) {
        console.error('Data fetch failed:', error);
        // Check if we have cached data
        const cachedData = localStorage.getItem('snowData');
        if (cachedData) {
            console.log('Using cached data');
            return JSON.parse(cachedData);
        }
        return [];
    } finally {
        clearTimeout(timeout);
    }
}
// Interpolate snow depth values
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

    // Sort data chronologically
    cleanData.sort((a, b) => a.date - b.date);

    // Get the first actual data point date
    const firstDataDate = cleanData[0].date;
    const firstValidSeasonYear = firstDataDate.getMonth() >= 7 ? 
        firstDataDate.getFullYear() : 
        firstDataDate.getFullYear() - 1;

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
        
        // Only process data for valid seasons (starting from firstValidSeasonYear)
        if (year >= firstValidSeasonYear) {
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
            cumulativeSnow += dailySnow;
            return cumulativeSnow;
        });

        return {
            name: season,
            depths: interpolatedDepths,
            cumulative: cumulative,
            isCurrent: data.isCurrent,
            hasData: interpolatedDepths.some(d => d !== null) || cumulative.some(c => c > 0)
        };
    })
    .filter(season => season.hasData) // Remove seasons with no actual data
    .sort((a, b) => a.name.localeCompare(b.name));

    // Calculate averages (excluding current season and ensuring we have valid data)
    const validSeasons = seasonsData.filter(s => !s.isCurrent && s.hasData);
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
                    color: 'white'
                }
            },
            tickfont: {
                color: 'white'
            }
        },
        yaxis: { 
            title: {
                text: yTitle,
                font: {
                    color: 'white'
                }
            },
            tickfont: {
                color: 'white'
            },
            hoverformat: '.1f',
            gridcolor: 'rgba(255, 255, 255, 0.1)'
        },
        plot_bgcolor: 'rgba(0,0,0,0)',
        paper_bgcolor: 'rgba(0,0,0,0)',
        hovermode: 'x unified',
        showlegend: true,
        legend: {
            font: {
                color: 'white',
                size: 12
            },
            bgcolor: 'rgba(0,0,0,0.7)',
            bordercolor: 'rgba(255,255,255,0.2)',
            borderwidth: 1,
            x: 0.02,           // Position from left
            y: 0.98,           // Position from bottom
            xanchor: 'left',   // Anchor point on legend
            yanchor: 'top',    // Anchor point on legend
            orientation: 'v'   // Vertical orientation
        },
        margin: { 
            t: 40,   // top margin
            b: 60,   // bottom margin
            l: 60,   // left margin
            r: 10    // reduced right margin since legend is overlaid
        },
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

        // Add background traces first (excluding current season and selected season)
        seasonsData.forEach(s => {
            if (!s.isCurrent && s.name !== seasonName) {
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
            line: { color: '#FFFFFF', width: 2 },
            hovertemplate: '%{customdata}<br>Average : %{y:.1f}<extra></extra>'
        });

        // Add current season trace if it's not the selected season
        const currentSeasonData = seasonsData.find(s => s.isCurrent);
        if (currentSeasonData && currentSeasonData.name !== seasonName) {
            traces.push({
                x: [...Array(365).keys()],
                y: isDepth ? currentSeasonData.depths : currentSeasonData.cumulative,
                customdata: customdata,
                name: `${currentSeasonData.name}`,
                line: { color: 'rgba(49, 247, 138, 0.38)', width: 3 }, 
                hovertemplate: `%{customdata}<br>${currentSeasonData.name} : %{y:.1f}<extra></extra>`
            });
        }

        // Add selected season trace
        traces.push({
            x: [...Array(365).keys()],
            y: isDepth ? season.depths : season.cumulative,
            customdata: customdata,
            name: season.name + (season.isCurrent ? '' : ''),
            line: { color: '#3177f7', width: 3 }, 
            hovertemplate: `%{customdata}<br>${season.name} : %{y:.1f}<extra></extra>`
        });

        Plotly.newPlot(chartId, traces, createLayout(
            isDepth ? 'Snow Depth' : 'Cumulative Snowfall',
            isDepth ? 'Snow Depth (inches)' : 'Cumulative Snowfall (inches)',
            seasonStartYear
        ));
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
            line: { color: '#FFFFFF', width: 2 },
            hovertemplate: '%{customdata}<br>Average : %{y:.1f}<extra></extra>'
        });

        Plotly.newPlot(chartId, traces, createLayout(
            isDepth ? 'Snow Depth' : 'Cumulative Snowfall',
            isDepth ? 'Snow Depth (inches)' : 'Cumulative Snowfall (inches)'
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

// Calculate statistics
function calculateStatistics(rawData) {
    // Filter valid data first
    const validData = rawData.filter(row => 
        row.SNWD !== null && row.SNWD !== -9999 && 
        row.SNOW !== null && row.SNOW !== -9999
    );

    // Then find the most recent data date using the filtered validData
    const validDates = validData
        .map(row => new Date(row.DATE))
        .sort((a, b) => b - a);  // Sort descending
    
    if (validDates.length > 0) {
        const lastDate = validDates[0].toLocaleDateString('en-US', { 
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
        document.getElementById('lastDataDate').textContent = lastDate;
    } else {
        document.getElementById('lastDataDate').textContent = 'No data available';
    }

    // Continue with the rest of the statistics calculations
    const maxDepth = Math.max(...validData.map(row => row.SNWD)) / 25.4;  // Convert to inches
    const maxDailySnowfall = Math.max(...validData.map(row => row.SNOW)) / 25.4;  // Convert to inches
    
    // Calculate season totals, ranks, and max depths
    const seasonTotals = {};
    const seasonMaxDepths = {};
    const startYear = parseInt(config.startDate.split('-')[0]); // Get year from startDate

    seasonsData.forEach(season => {
        // Skip seasons before our startDate year
        const seasonStartYear = parseInt(season.name.split('-')[0]);
        if (seasonStartYear < startYear) return;

        // Calculate total snowfall for the season
        let totalSnow = season.cumulative[season.cumulative.length - 1];
        
        // For current season, use the last valid cumulative value
        if (season.isCurrent) {
            const lastValidIndex = season.cumulative.findLastIndex(val => val !== null && !isNaN(val));
            totalSnow = lastValidIndex >= 0 ? season.cumulative[lastValidIndex] : 0;
        }
        
        if (totalSnow !== null && !isNaN(totalSnow)) {
            seasonTotals[season.name] = totalSnow;
        } else if (season.isCurrent) {
            // Ensure current season is included even if no snow yet
            seasonTotals[season.name] = 0;
        }
        
        // Calculate max depth for the season
        const maxSeasonDepth = Math.max(...season.depths.filter(d => d !== null && !isNaN(d)));
        if (!isNaN(maxSeasonDepth)) {
            seasonMaxDepths[season.name] = maxSeasonDepth;
        }
    });

    // Sort seasons by total snowfall
    const rankedSeasons = Object.entries(seasonTotals)
        .sort(([,a], [,b]) => b - a)
        .map(([season, total], index) => ({
            rank: index + 1,
            season,
            total,
            isCurrent: season === currentSeason
        }));

    // Calculate averages (excluding current season)
    const completedSeasons = Object.entries(seasonTotals).filter(([season]) => season !== currentSeason);
    const avgTotalSnow = completedSeasons.reduce((a, [,b]) => a + b, 0) / completedSeasons.length;
    const avgMaxDepth = Object.values(seasonMaxDepths).reduce((a, b) => a + b, 0) / Object.values(seasonMaxDepths).length;

    // Update snowiest seasons table
    const tbody = document.getElementById('snowiest-table').getElementsByTagName('tbody')[0];
    tbody.innerHTML = '';

    // Get current season's rank and data
    const currentSeasonData = rankedSeasons.find(s => s.isCurrent);
    const lastRankedSeason = rankedSeasons[rankedSeasons.length - 1];
    
    // Determine which seasons to show
    let seasonsToShow = [];
    
    // Always show top 5
    seasonsToShow = rankedSeasons.slice(0, 5);

    // Handle additional seasons display
    if (currentSeasonData) {
        if (currentSeasonData.rank <= 5) {
            // Current season is in top 5
            if (lastRankedSeason !== currentSeasonData) {
                seasonsToShow.push({ isEllipsis: true });
                seasonsToShow.push(lastRankedSeason);
            }
        } else {
            // Current season is not in top 5
            seasonsToShow.push({ isEllipsis: true }); // First ellipsis after top 5
            seasonsToShow.push(currentSeasonData);
            
            // Add ellipsis between current and last season if they're not consecutive
            if (currentSeasonData !== lastRankedSeason) {
                seasonsToShow.push({ isEllipsis: true }); // Second ellipsis between current and last
                seasonsToShow.push(lastRankedSeason);
            }
        }
    } else if (!seasonsToShow.includes(lastRankedSeason)) {
        // No current season, add last season if not already shown
        seasonsToShow.push({ isEllipsis: true });
        seasonsToShow.push(lastRankedSeason);
    }

    // Render the table
    seasonsToShow.forEach((data) => {
        const tr = document.createElement('tr');
        
        if (data.isEllipsis) {
            tr.innerHTML = `
                <td>...</td>
                <td>...</td>
                <td>...</td>
            `;
        } else {
            tr.className = data.season === currentSeason ? 'current-season' : '';
            tr.innerHTML = `
                <td>${data.rank}</td>
                <td>${data.season}</td>
                <td>${data.total.toFixed(1)}</td>
            `;
        }
        tbody.appendChild(tr);
    });
}

(async function init() {
    try {
        // Show loading state
        document.getElementById('lastDataDate').textContent = 'Loading data...';
        
        // Try to get cached data first
        let rawData = null;
        try {
            const cachedData = localStorage.getItem('snowData');
            if (cachedData) {
                const cached = JSON.parse(cachedData);
                const cacheDate = localStorage.getItem('snowDataTimestamp');
                
                // Only use cache if it's less than 24 hours old
                if (cacheDate && (Date.now() - parseInt(cacheDate)) < 24 * 60 * 60 * 1000) {
                    rawData = cached;
                    console.log('Using cached data');
                }
            }
        } catch (e) {
            console.warn('Error reading cache:', e);
        }

        // If no valid cached data, fetch new data
        if (!rawData) {
            rawData = await fetchData();
            
            // Cache the new data if valid
            if (rawData && rawData.length > 0) {
                try {
                    localStorage.setItem('snowData', JSON.stringify(rawData));
                    localStorage.setItem('snowDataTimestamp', Date.now().toString());
                } catch (e) {
                    console.warn('Error caching data:', e);
                }
            }
        }

        // Process and display the data
        if (rawData && rawData.length > 0) {
            processSeasons(rawData);
            calculateStatistics(rawData);        
            createBaseCharts();
            populateSeasonSelector();
            
            // Initialize with the most recent season
            if (seasonsData.length > 0) {
                const selector = document.getElementById('seasonSelector');
                selector.value = seasonsData[seasonsData.length - 1].name;
                updateHighlightedSeason(seasonsData[seasonsData.length - 1].name);
            }
        } else {
            throw new Error('No data available');
        }
    } catch (error) {
        console.error('Initialization failed:', error);
        document.getElementById('lastDataDate').textContent = 'Error loading data. Please refresh the page.';
    }
})();