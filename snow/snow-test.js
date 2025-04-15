// Configuration and State
const config = {
    token: 'nXmOKjrZlqFObwTYdKyPRurnbZhVvTZz', // V2 API token
    station: 'GHCND:USW00014755',              // V2 API station format
    startDate: '1948-08-01',
    endDate: new Date().toISOString().split('T')[0],
    dataTypes: ['SNOW', 'SNWD'],               // Array format for separate API calls
    baseURL: 'https://www.ncdc.noaa.gov/cdo-web/api/v2/data', // V2 API endpoint
    retryCount: 3,                             // Max retry attempts per chunk
    chunkSize: 90,                             // Days per chunk (smaller chunks)
    requestTimeout: 60000                      // Timeout for individual requests (60 seconds)
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

// Helper function to create date chunks
function createDateChunks(startDate, endDate, chunkSizeDays) {
    const chunks = [];
    const startDateObj = new Date(startDate);
    const endDateObj = new Date(endDate);
    
    let chunkStartDate = new Date(startDateObj);
    
    while (chunkStartDate < endDateObj) {
        let chunkEndDate = new Date(chunkStartDate);
        chunkEndDate.setDate(chunkEndDate.getDate() + chunkSizeDays - 1); // Inclusive end date
        
        // Ensure the chunk doesn't exceed the end date
        if (chunkEndDate > endDateObj) {
            chunkEndDate = new Date(endDateObj);
        }
        
        chunks.push({
            start: chunkStartDate.toISOString().split('T')[0],
            end: chunkEndDate.toISOString().split('T')[0]
        });
        
        // Move to the next chunk
        chunkStartDate = new Date(chunkEndDate);
        chunkStartDate.setDate(chunkStartDate.getDate() + 1);
    }
    
    return chunks;
}

// Fetch data for a specific data type and date range
async function fetchDataChunk(dataType, startDate, endDate, controller, retryCount = 0) {
    // If we've exceeded retry count, return empty results to avoid infinite loops
    if (retryCount >= config.retryCount) {
        console.warn(`Maximum retry count (${config.retryCount}) exceeded for ${dataType} from ${startDate} to ${endDate}. Giving up.`);
        return [];
    }

    const url = new URL(config.baseURL);
    url.searchParams.set('datasetid', 'GHCND');
    url.searchParams.set('stationid', config.station);
    url.searchParams.set('datatypeid', dataType);
    url.searchParams.set('startdate', startDate);
    url.searchParams.set('enddate', endDate);
    url.searchParams.set('limit', 1000);
    url.searchParams.set('units', 'metric'); // Use metric for mm (to match original V1 API data units)
    
    console.log(`Fetching ${dataType} data from ${startDate} to ${endDate}...${retryCount > 0 ? ` (Retry ${retryCount})` : ''}`);
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'token': config.token
            },
            signal: controller.signal,
            cache: 'no-cache'
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`API Error Response: ${errorText}`);
            
            // If the controller is already aborted, just propagate the abort
            if (controller.signal.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }
            
            // Calculate backoff time based on retry count (exponential backoff)
            const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
            
            if (response.status === 429 || response.status === 503 || response.status === 403) {
                console.log(`Rate limited or service unavailable. Waiting ${backoffTime/1000} seconds before retry...`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
                return fetchDataChunk(dataType, startDate, endDate, controller, retryCount + 1);
            }
            
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        return data && data.results ? data.results : [];
    } catch (error) {
        console.error(`Error fetching ${dataType} from ${startDate} to ${endDate}:`, error);
        
        // Propagate AbortError to be handled by the caller
        if (error.name === 'AbortError') {
            throw error;
        }
        
        // Calculate backoff time based on retry count (exponential backoff)
        const backoffTime = Math.min(15000, 2000 * Math.pow(1.5, retryCount));
        
        // Retry most errors (not needed to check for AbortError since we already did above)
        console.log(`Network error. Waiting ${backoffTime/1000} seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        return fetchDataChunk(dataType, startDate, endDate, controller, retryCount + 1);
    }
}

// Data Fetching
async function fetchData() {
    try {
        // Check for cached data first
        const cachedData = localStorage.getItem('snowData');
        const cacheTimestamp = localStorage.getItem('snowDataTimestamp');
        
        if (cachedData && cacheTimestamp) {
            const cacheAge = Date.now() - parseInt(cacheTimestamp);
            if (cacheAge < 24 * 60 * 60 * 1000) { // 24 hour cache
                console.log('Using cached data');
                return JSON.parse(cachedData);
            }
        }
        
        // Create date chunks to handle the large date range
        const chunks = createDateChunks(config.startDate, config.endDate, config.chunkSize);
        const allResults = new Map();
        
        // Process data with adaptive delay and individual request timeouts
        let completedChunks = 0;
        let failedChunks = 0;
        const totalChunks = config.dataTypes.length * chunks.length;
        let lastProgressUpdate = 0;
        
        // Create a function to process a single dataType and chunk
        async function processChunk(dataType, chunk, retryCount = 0) {
            // If we've exceeded retry count, give up on this chunk
            if (retryCount >= config.retryCount) {
                console.warn(`Maximum retry count (${config.retryCount}) exceeded for ${dataType} from ${chunk.start} to ${chunk.end}. Giving up.`);
                completedChunks++;
                failedChunks++;
                // Update progress display
                const percent = Math.round((completedChunks / totalChunks) * 100);
                document.getElementById('lastDataDate').textContent = 
                    `Loading data... ${percent}% complete (${failedChunks} errors)`;
                return;
            }
            
            try {
                // Create per-request abort controller with timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => {
                    controller.abort('timeout'); // Mark this abort as a timeout
                    console.warn(`Request timeout for ${dataType} from ${chunk.start} to ${chunk.end} - will retry`);
                }, config.requestTimeout); // Use configurable timeout
                
                try {
                    const results = await fetchDataChunk(dataType, chunk.start, chunk.end, controller);
                    clearTimeout(timeoutId); // Clear timeout if request completes
                    
                    if (results.length > 0) {
                        // Process results for this data type
                        for (const item of results) {
                            const date = item.date.split('T')[0]; // Extract date part
                            
                            if (!allResults.has(date)) {
                                allResults.set(date, { DATE: date, SNOW: -9999, SNWD: -9999 });
                            }
                            
                            const entry = allResults.get(date);
                            if (dataType === 'SNOW') {
                                entry.SNOW = item.value;
                            } else if (dataType === 'SNWD') {
                                entry.SNWD = item.value;
                            }
                        }
                        
                        // Success - increment completed and update progress
                        completedChunks++;
                        const now = Date.now();
                        if (now - lastProgressUpdate > 1000) {
                            const percent = Math.round((completedChunks / totalChunks) * 100);
                            const failureRate = failedChunks > 0 ? Math.round((failedChunks / completedChunks) * 100) : 0;
                            document.getElementById('lastDataDate').textContent = 
                                `Loading data... ${percent}% complete (${failedChunks} errors)`;
                            lastProgressUpdate = now;
                            
                            // Adaptive delay based on failure rate
                            if (failureRate > 20) {
                                await new Promise(resolve => setTimeout(resolve, 3000)); // Longer delay if high failure rate
                            } else {
                                await new Promise(resolve => setTimeout(resolve, 1000)); // Normal delay
                            }
                        } else {
                            // Regular delay between requests
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    } else {
                        console.warn(`No data returned for ${dataType} from ${chunk.start} to ${chunk.end}, retrying...`);
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Brief delay before retry
                        return processChunk(dataType, chunk, retryCount + 1); // Retry on empty results
                    }
                } catch (error) {
                    clearTimeout(timeoutId); // Make sure to clear timeout on error
                    
                    // Check if this was a timeout abort
                    if (error.name === 'AbortError') {
                        console.log(`Request for ${dataType} from ${chunk.start} to ${chunk.end} aborted, retrying...`);
                        // Retry on timeout
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Brief delay before retry
                        return processChunk(dataType, chunk, retryCount + 1);
                    } else {
                        console.error(`Error processing ${dataType} from ${chunk.start} to ${chunk.end}:`, error);
                        // Retry on other errors
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Brief delay before retry
                        return processChunk(dataType, chunk, retryCount + 1);
                    }
                }
                
            } catch (error) {
                console.error(`Critical error processing chunk for ${dataType}:`, error);
                completedChunks++; // Still count as completed to avoid hanging
                failedChunks++;
                
                // Update progress display
                const percent = Math.round((completedChunks / totalChunks) * 100);
                document.getElementById('lastDataDate').textContent = 
                    `Loading data... ${percent}% complete (${failedChunks} errors)`;
            }
        }
        
        // Process chunks sequentially to avoid overwhelming the API
        for (const dataType of config.dataTypes) {
            for (const chunk of chunks) {
                await processChunk(dataType, chunk);
            }
        }
        
        // Convert map to array and sort by date
        const combinedResults = Array.from(allResults.values());
        combinedResults.sort((a, b) => a.DATE.localeCompare(b.DATE));
        
        // Show summary after data fetching completes
        if (totalChunks > 0) {
            const successRate = Math.round(((totalChunks - failedChunks) / totalChunks) * 100);
            console.log(`Data fetching complete. Success rate: ${successRate}% (${totalChunks - failedChunks}/${totalChunks} chunks)`);
        }
        
        // Save to cache if we have meaningful results
        if (combinedResults.length > 0) {
            try {
                localStorage.setItem('snowData', JSON.stringify(combinedResults));
                localStorage.setItem('snowDataTimestamp', Date.now().toString());
                console.log(`Cached ${combinedResults.length} days of data`);
            } catch (e) {
                console.warn('Error caching data:', e);
            }
        } else {
            console.warn('No data collected to cache');
        }
        
        return combinedResults;
    } catch (error) {
        console.error('Data fetch failed:', error);
        // Fallback to cached data if available
        const cachedData = localStorage.getItem('snowData');
        if (cachedData) {
            console.log('Using cached data due to error');
            return JSON.parse(cachedData);
        }
        // If we have no cached data, return an empty array rather than null
        // This will prevent errors downstream and show "no data available" message
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