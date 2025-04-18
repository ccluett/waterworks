// Configuration and State
const config = {
    workerURL: 'https://snowfall-proxy.cluett26.workers.dev',
    startDate: '1948-08-01'
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

// Enhanced client-side implementation for server-side loading
async function fetchData() {
    try {
        // Check for cached data first
        const cachedData = localStorage.getItem('snowData');
        const cacheTimestamp = localStorage.getItem('snowDataTimestamp');
        
        // Update UI to show loading state
        const lastDataElement = document.getElementById('lastDataDate');
        lastDataElement.textContent = 'Loading data from server...';
        
        // Add a loading class to the element for styling
        if (lastDataElement.classList) {
            lastDataElement.classList.add('loading');
        }
        
        // Use cached data if it's less than 12 hours old
        if (cachedData && cacheTimestamp) {
            const cacheAge = Date.now() - parseInt(cacheTimestamp);
            if (cacheAge < 12 * 60 * 60 * 1000) { // 12 hour cache
                console.log('Using cached data from localStorage');
                
                // Still fetch in the background to check for updates
                setTimeout(() => {
                    fetch(config.workerURL)
                        .then(response => response.ok ? response.json() : null)
                        .then(data => {
                            if (data && data.length > 0) {
                                // Only update if we got valid data and it's different than what we have
                                const currentData = JSON.parse(localStorage.getItem('snowData') || '[]');
                                if (data.length !== currentData.length) {
                                    console.log(`Updating local cache with new server data (${data.length} records)`);
                                    localStorage.setItem('snowData', JSON.stringify(data));
                                    localStorage.setItem('snowDataTimestamp', Date.now().toString());
                                    
                                    // Notify user that new data is available
                                    const notification = document.createElement('div');
                                    notification.className = 'update-notification';
                                    notification.innerHTML = `
                                        <div style="position: fixed; bottom: 20px; right: 20px; background: rgba(0,0,0,0.8); 
                                                    color: white; padding: 10px; border-radius: 5px; z-index: 1000;">
                                            New data available! <button id="reload-btn">Reload</button>
                                        </div>
                                    `;
                                    document.body.appendChild(notification);
                                    
                                    document.getElementById('reload-btn').addEventListener('click', () => {
                                        location.reload();
                                    });
                                }
                            }
                        })
                        .catch(err => console.warn('Background data check failed:', err));
                }, 2000);
                
                return JSON.parse(cachedData);
            }
        }
        
        // Fetch from our Worker
        console.log('Fetching data from worker...');
        
        const response = await fetch(config.workerURL);
        
        // Handle different response scenarios
        if (response.status === 503) {
            // Server is still building data
            const responseData = await response.json();
            console.log('Server is still building data:', responseData.message);
            
            // Show a friendly message to the user
            lastDataElement.textContent = 'Server is currently building the dataset. Initial data will be available soon.';
            
            // Update UI to show a progress indicator
            const progressIndicator = document.createElement('div');
            progressIndicator.id = 'build-progress';
            progressIndicator.innerHTML = `
                <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.7); border-radius: 4px;">
                    <div>Dataset is being prepared...</div>
                    <div style="width: 100%; height: 4px; background: #333; margin-top: 5px;">
                        <div style="height: 100%; width: 20%; background: #3177f7; animation: pulse 2s infinite;"></div>
                    </div>
                    <style>
                        @keyframes pulse {
                            0% { opacity: 0.6; }
                            50% { opacity: 1; }
                            100% { opacity: 0.6; }
                        }
                    </style>
                </div>
            `;
            lastDataElement.parentNode.appendChild(progressIndicator);
            
            // Check if we have cached data to use while waiting
            if (cachedData) {
                console.log('Using cached data while server builds dataset');
                return JSON.parse(cachedData);
            }
            
            // Return an empty array which will show no data visualization
            return [];
        }
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log(`Received ${data.length} records from server`);
        
        // Remove loading state
        if (lastDataElement.classList) {
            lastDataElement.classList.remove('loading');
        }
        
        // Update the last data date display
        const currentDate = new Date();
        lastDataElement.textContent = `Data updated: ${currentDate.toLocaleDateString()} ${currentDate.toLocaleTimeString()}`;
        
        // Clean up any progress indicators
        const progressElem = document.getElementById('build-progress');
        if (progressElem) {
            progressElem.remove();
        }
        
        // Save to cache if we have meaningful results
        if (data && data.length > 0) {
            try {
                localStorage.setItem('snowData', JSON.stringify(data));
                localStorage.setItem('snowDataTimestamp', Date.now().toString());
                console.log(`Cached ${data.length} days of data locally`);
            } catch (e) {
                console.warn('Error caching data:', e);
            }
        }
        
        return data;
    } catch (error) {
        console.error('Data fetch failed:', error);
        
        // Update UI to show error
        const lastDataElement = document.getElementById('lastDataDate');
        lastDataElement.textContent = `Error: ${error.message}`;
        lastDataElement.style.color = '#ff6b6b';
        
        // Remove loading state
        if (lastDataElement.classList) {
            lastDataElement.classList.remove('loading');
        }
        
        // Fallback to cached data if available
        const cachedData = localStorage.getItem('snowData');
        if (cachedData) {
            console.log('Using cached data due to error');
            return JSON.parse(cachedData);
        }
        return [];
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
    const startYear = 1948; // Hardcoded start year instead of parsing from config.startDate

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
        
        // Check for force reload parameter
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('forcereload')) {
            console.log('Forced reload requested, clearing cache...');
            localStorage.removeItem('snowData');
            localStorage.removeItem('snowDataTimestamp');
        }
        
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
                    console.log(`Using cached data (${cached.length} records)`);
                }
            }
        } catch (e) {
            console.warn('Error reading cache:', e);
        }

        // If no valid cached data, fetch new data
        if (!rawData) {
            rawData = await fetchData();
        }

        // Process and display the data - use ANY data we have, don't throw error if it's not "complete"
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
            
            // Add debug tools at the bottom if needed
            if (urlParams && urlParams.has('debug')) {
                addDebugTools();
            }
        } else {
            document.getElementById('lastDataDate').textContent = 'No data available. Please try again later.';
            console.warn('No data available for display');
        }
    } catch (error) {
        console.error('Initialization failed:', error);
        // Fallback to a user-friendly message instead of an error
        document.getElementById('lastDataDate').textContent = 'Error loading data. Please try again later.';
    }
})();

// Debug tools function
function addDebugTools() {
    const debugDiv = document.createElement('div');
    debugDiv.innerHTML = `
        <div style="margin-top: 20px; padding: 10px; background: rgba(0,0,0,0.7); border: 1px solid #666;">
            <h3 style="color: white;">Debug Tools</h3>
            <button id="viewCacheBtn">View Cache Info</button>
            <button id="clearCacheBtn">Clear Cache & Reload</button>
            <div id="cacheInfo" style="margin-top: 10px; font-family: monospace; color: white;"></div>
        </div>
    `;
    document.querySelector('.container').appendChild(debugDiv);
    
    document.getElementById('viewCacheBtn').addEventListener('click', function() {
        const cached = localStorage.getItem('snowData');
        const timestamp = localStorage.getItem('snowDataTimestamp');
        const cacheAge = timestamp ? Math.round((Date.now() - parseInt(timestamp)) / (60*1000)) : 'N/A';
        
        document.getElementById('cacheInfo').innerHTML = `
            Cache exists: ${cached ? 'Yes' : 'No'}<br>
            Cache age: ${cacheAge} minutes<br>
            Cache size: ${cached ? Math.round(cached.length/1024) : 0} KB
        `;
    });
    
    document.getElementById('clearCacheBtn').addEventListener('click', function() {
        localStorage.removeItem('snowData');
        localStorage.removeItem('snowDataTimestamp');
        location.reload();
    });
}