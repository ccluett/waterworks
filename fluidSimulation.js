// Enhanced Fluid Simulation with improved physics and visuals //

class FluidSimulation {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.hasInitialized = false;
        this.options = options;
        this.currentAngle = -0.261799; // ~-15 degrees

        // Dimensions
        this.width = canvas.width;
        this.height = canvas.height;
        this.pxPerSquare = options.pxPerSquare || 1;
        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);
        if (this.xdim < 50) this.xdim = 50;
        if (this.ydim < 50) this.ydim = 50;

        // LBM constants
        this.four9ths = 4.0 / 9.0;
        this.one9th = 1.0 / 9.0;
        this.one36th = 1.0 / 36.0;

        // MRT collision parameters
        this.useMRT = true; // Enable Multi-Relaxation Time
        this.initMRTParameters();

        // Simulation parameters
        this.flowSpeed = options.flowSpeed || 0.2;
        this.flowAngle = (options.flowAngleDeg || 0) * Math.PI / 180;
        this.viscosity = options.viscosity || 0.01;
        this.running = false;
        this.chordLength = 0; // Will be set during airfoil creation

        // Arrays
        this.initArrays();

        // Visualization settings
        this.visualizationMode = 'speed'; // 'speed', 'curl', 'pressure'
        this.showStreamlines = false;
        this.showForceVectors = false;
        this.forceUpdateInterval = 10; // Update forces every 10 frames
        this.frameCount = 0;

        // imageData for rendering
        this.imageData = this.ctx.createImageData(this.width, this.height);
        for (let i = 3; i < this.imageData.data.length; i += 4) {
            this.imageData.data[i] = 255;
        }

        // Physics measurements
        this.forces = { lift: 0, drag: 0 };
        this.reynoldsNumber = 0;

        // Initialize color maps for different visualizations
        this.initColorMaps();

        // 1) Initialize domain at rest
        this.initFluid();

        // 2) Add the airfoil barrier (polygon fill)
        this.addNACABarrier({
            chordFraction: 1/3,
            thickness: 0.12,
            angle: this.currentAngle
        });

        // 3) Start simulation
        this.draw();  // Draw the initial state regardless of running
        if (this.running) {
            this.update();
        }
    }

    initMRTParameters() {
        // MRT relaxation parameters for different moments
        // This provides better stability than single relaxation time
        this.s_nu = 1.0 / (3.0 * this.viscosity + 0.5); // viscosity-related relaxation
        this.s_e = 1.3;  // energy relaxation
        this.s_eps = 1.3; // energy-squared relaxation
        this.s_q = 1.2;  // heat flux relaxation
        this.s_nu_bulk = 1.0; // bulk viscosity relaxation
        
        // MRT transformation matrix (d'Humieres et al, 2002)
        this.M = [
            [1, 1, 1, 1, 1, 1, 1, 1, 1],                  // density
            [-4, -1, -1, -1, -1, 2, 2, 2, 2],             // energy
            [4, -2, -2, -2, -2, 1, 1, 1, 1],              // energy squared
            [0, 1, 0, -1, 0, 1, -1, -1, 1],               // x-momentum
            [0, -2, 0, 2, 0, 1, -1, -1, 1],               // x-energy flux
            [0, 0, 1, 0, -1, 1, 1, -1, -1],               // y-momentum
            [0, 0, -2, 0, 2, 1, 1, -1, -1],               // y-energy flux
            [0, 1, -1, 1, -1, 0, 0, 0, 0],                // diagonal stress
            [0, 0, 0, 0, 0, 1, -1, 1, -1]                 // off-diagonal stress
        ];
        
        // Inverse MRT matrix (precomputed for efficiency)
        this.Minv = [
            [1/9, -1/9, 1/9, 0, 0, 0, 0, 0, 0],
            [1/9, -1/36, -1/18, 1/6, -1/6, 0, 0, 1/4, 0],
            [1/9, -1/36, -1/18, 0, 0, 1/6, -1/6, -1/4, 0],
            [1/9, -1/36, -1/18, -1/6, 1/6, 0, 0, 1/4, 0],
            [1/9, -1/36, -1/18, 0, 0, -1/6, 1/6, -1/4, 0],
            [1/9, 1/18, 1/36, 1/6, 1/12, 1/6, 1/12, 0, 1/4],
            [1/9, 1/18, 1/36, -1/6, -1/12, 1/6, 1/12, 0, -1/4],
            [1/9, 1/18, 1/36, -1/6, -1/12, -1/6, -1/12, 0, 1/4],
            [1/9, 1/18, 1/36, 1/6, 1/12, -1/6, -1/12, 0, -1/4]
        ];
        
        // Relaxation matrix (diagonal matrix of relaxation rates)
        this.S = [
            1.0,         // density conservation (no relaxation)
            this.s_e,    // energy
            this.s_eps,  // energy squared
            1.0,         // x-momentum conservation
            this.s_q,    // x-energy flux
            1.0,         // y-momentum conservation
            this.s_q,    // y-energy flux
            this.s_nu,   // diagonal stress (shear viscosity)
            this.s_nu    // off-diagonal stress (shear viscosity)
        ];
    }

    initArrays() {
        const size = this.xdim * this.ydim;
        this.n0  = new Float32Array(size);
        this.nN  = new Float32Array(size);
        this.nS  = new Float32Array(size);
        this.nE  = new Float32Array(size);
        this.nW  = new Float32Array(size);
        this.nNE = new Float32Array(size);
        this.nSE = new Float32Array(size);
        this.nNW = new Float32Array(size);
        this.nSW = new Float32Array(size);
        this.rho = new Float32Array(size);
        this.ux  = new Float32Array(size);
        this.uy  = new Float32Array(size);
        this.curl = new Float32Array(size);  
        this.pressure = new Float32Array(size);
        this.speed = new Float32Array(size);
        this.barriers = new Uint8Array(size);
        
        // For streamline visualization
        this.streamlines = [];
    }

    initFluid() {
        // Initialize entire domain to match inlet velocity and density
        const ux0 = this.flowSpeed * Math.cos(this.flowAngle);
        const uy0 = this.flowSpeed * Math.sin(this.flowAngle);
        const rho0 = 1.0;  // reference density
    
        // Set the entire domain to the inlet conditions
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                this.setEquilibrium(x, y, ux0, uy0, rho0);
                this.pressure[x + y * this.xdim] = rho0 / 3; // Initial pressure (cs^2 * rho)
            }
        }
    
        for (let i = 0; i < this.curl.length; i++) {
            this.curl[i] = 0.0;
        }

        // Zero out any velocities in barrier cells
        this._zeroOutBarrierCells();
        
        // Calculate Reynolds number
        this.updateReynoldsNumber();
    }

    updateReynoldsNumber() {
        if (this.chordLength > 0) {
            // Re = ρ⋅U⋅L/μ where L is chord length and μ is dynamic viscosity
            // In LBM, kinematic viscosity ν = μ/ρ, so Re = U⋅L/ν
            this.reynoldsNumber = this.flowSpeed * this.chordLength / this.viscosity;
        }
    }

    updateAngle(newAngle) {
        this.currentAngle = newAngle;
        this.initArrays();
        this.initFluid();
        this.addNACABarrier({
            chordFraction: 1/3.5,
            thickness: 0.12,
            angle: this.currentAngle
        });
    }

    setVisualizationMode(mode) {
        if (['speed', 'curl', 'pressure'].includes(mode)) {
            this.visualizationMode = mode;
        }
    }

    toggleStreamlines() {
        this.showStreamlines = !this.showStreamlines;
    }

    toggleForceVectors() {
        this.showForceVectors = !this.showForceVectors;
    }

    initColorMaps() {
        // Initialize color maps for different visualization modes
        this.nColors = 400;
        
        // Speed/Velocity colormap (blue to red)
        this.speedColors = new Array(this.nColors);
        for (let i = 0; i < this.nColors; i++) {
            const phase = i / this.nColors;
            let r, g, b;

            if (phase < 0.125) {
                r = 0; g = 0;
                b = Math.round(255 * (phase + 0.125) / 0.25);
            } else if (phase < 0.375) {
                r = 0;
                g = Math.round(255 * (phase - 0.125) / 0.25);
                b = 255;
            } else if (phase < 0.625) {
                r = Math.round(255 * (phase - 0.375) / 0.25);
                g = 255;
                b = 255 - r;
            } else if (phase < 0.875) {
                r = 255;
                g = Math.round(255 * (0.875 - phase) / 0.25);
                b = 0;
            } else {
                r = Math.round(255 * (1.125 - phase) / 0.25);
                g = 0; 
                b = 0;
            }
            this.speedColors[i] = { r, g, b };
        }
        
        // Vorticity/Curl colormap (divergent - red to blue)
        this.curlColors = new Array(this.nColors);
        for (let i = 0; i < this.nColors; i++) {
            const phase = i / this.nColors;
            let r, g, b;
            
            if (phase < 0.5) {
                // Blue to white
                const t = phase * 2;
                r = Math.round(255 * t);
                g = Math.round(255 * t);
                b = 255;
            } else {
                // White to red
                const t = (phase - 0.5) * 2;
                r = 255;
                g = Math.round(255 * (1 - t));
                b = Math.round(255 * (1 - t));
            }
            
            this.curlColors[i] = { r, g, b };
        }
        
        // Pressure colormap (cool to warm - purple to orange)
        this.pressureColors = new Array(this.nColors);
        for (let i = 0; i < this.nColors; i++) {
            const phase = i / this.nColors;
            let r, g, b;
            
            // Purple to orange
            if (phase < 0.33) {
                const t = phase * 3;
                r = Math.round(128 + 127 * t);
                g = Math.round(0 + 128 * t);
                b = Math.round(128 * (1 - t));
            } else if (phase < 0.67) {
                const t = (phase - 0.33) * 3;
                r = 255;
                g = Math.round(128 + 127 * t);
                b = 0;
            } else {
                const t = (phase - 0.67) * 3;
                r = Math.round(255 * (1 - 0.2 * t));
                g = 255;
                b = Math.round(153 * t);
            }
            
            this.pressureColors[i] = { r, g, b };
        }
        
        // Default to speed colors for backward compatibility
        this.colors = this.speedColors;
    }

    computeDensity(i) {
        return this.n0[i] + this.nN[i] + this.nS[i] + this.nE[i] + this.nW[i] + 
               this.nNW[i] + this.nNE[i] + this.nSW[i] + this.nSE[i];
    }

    setEquilibrium(x, y, ux, uy, rho) {
        const i = x + y * this.xdim;
        const ux3 = 3 * ux;
        const uy3 = 3 * uy;
        const ux2 = ux * ux;
        const uy2 = uy * uy;
        const uxuy2 = 2 * ux * uy;
        const u2 = ux2 + uy2;
        const u215 = 1.5 * u2;

        this.n0[i]  = this.four9ths * rho * (1 - u215);
        this.nE[i]  = this.one9th   * rho * (1 + ux3 + 4.5*ux2 - u215);
        this.nW[i]  = this.one9th   * rho * (1 - ux3 + 4.5*ux2 - u215);
        this.nN[i]  = this.one9th   * rho * (1 + uy3 + 4.5*uy2 - u215);
        this.nS[i]  = this.one9th   * rho * (1 - uy3 + 4.5*uy2 - u215);
        this.nNE[i] = this.one36th  * rho * (1 + ux3 + uy3 + 4.5*(u2+uxuy2) - u215);
        this.nSE[i] = this.one36th  * rho * (1 + ux3 - uy3 + 4.5*(u2-uxuy2) - u215);
        this.nNW[i] = this.one36th  * rho * (1 - ux3 + uy3 + 4.5*(u2-uxuy2) - u215);
        this.nSW[i] = this.one36th  * rho * (1 - ux3 - uy3 + 4.5*(u2+uxuy2) - u215);

        this.rho[i] = rho;
        this.ux[i]  = ux;
        this.uy[i]  = uy;
    }


    //  AIRFOIL GENERATION  // 

    addNACABarrier({ chordFraction = 1/3, thickness = 0.12, angle = 0 }) {
        const chordLength = Math.floor(this.xdim * chordFraction);
        this.chordLength = chordLength; // Store for Reynolds calculation
        const centerX = Math.floor(this.xdim / 3);
        const centerY = Math.floor(this.ydim / 2);

        // NACA thickness function
        const nacaThickness = (xFrac) => {
            return (thickness / 0.2) * chordLength * (
                0.2969 * Math.sqrt(xFrac) -
                0.1260 * xFrac -
                0.3516 * xFrac**2 +
                0.2843 * xFrac**3 -
                0.1015 * xFrac**4
            );
        };

        // NACA camber function (adding camber for more realistic airfoil)
        const nacaCamber = (xFrac) => {
            const camberRatio = 0.04; // 4% camber
            const camberPosition = 0.4; // Position of max camber
            
            if (xFrac <= camberPosition) {
                return camberRatio * (xFrac / Math.pow(camberPosition, 2)) * 
                      (2 * camberPosition - xFrac) * chordLength;
            } else {
                return camberRatio * ((1 - xFrac) / Math.pow(1 - camberPosition, 2)) * 
                      (1 + xFrac - 2 * camberPosition) * chordLength;
            }
        };

        // 1) Generate top/bottom edges with camber
        const { topPoints, botPoints } = this._generateAirfoilPoints(
            chordLength, centerX, centerY, angle, nacaThickness, nacaCamber
        );

        // Store airfoil data for force calculations
        this.airfoilData = {
            centerX,
            centerY,
            chordLength,
            angle,
            topPoints,
            botPoints
        };

        // 2) Build a closed polygon
        const polygon = this._buildAirfoilPolygon(topPoints, botPoints);

        // 3) Fill polygon into this.barriers
        this._fillPolygon(polygon, this.barriers);

        // 4) Zero out fluid in all barrier cells
        this._zeroOutBarrierCells();
        
        // Update Reynolds number after changing airfoil
        this.updateReynoldsNumber();
    }

    // Generate top & bottom edge points for chord slices including camber
    _generateAirfoilPoints(chordLength, centerX, centerY, angle, thicknessFunc, camberFunc) {
        const cosAng = Math.cos(angle);
        const sinAng = Math.sin(angle);

        const topPoints = [];
        const botPoints = [];

        for (let i = 0; i <= chordLength; i++) {
            const xFrac = i / chordLength;
            const halfThick = thicknessFunc(xFrac);
            const camber = camberFunc(xFrac);

            // Calculate camber point position
            const xCamber = centerX + i * cosAng - camber * sinAng;
            const yCamber = centerY + i * sinAng + camber * cosAng;

            // offset top & bottom from camber line
            const xTop = Math.round(xCamber - halfThick * sinAng);
            const yTop = Math.round(yCamber + halfThick * cosAng);
            const xBot = Math.round(xCamber + halfThick * sinAng);
            const yBot = Math.round(yCamber - halfThick * cosAng);

            topPoints.push({ x: xTop, y: yTop });
            botPoints.push({ x: xBot, y: yBot });
        }

        return { topPoints, botPoints };
    }

    // Create a single closed polygon from top & bottom edges
    _buildAirfoilPolygon(topPoints, botPoints) {
        // Reverse the bottom array so we get a continuous loop
        const reversedBot = botPoints.slice().reverse();
        // Combine them
        const polygon = topPoints.concat(reversedBot);
        return polygon;
    }

    
    // Fill the polygon via a simple scan-line approach
    _fillPolygon(polygon, barrierArray) {
        // 1. Find bounding box
        let minY = Infinity, maxY = -Infinity;
        for (const pt of polygon) {
            if (pt.y < minY) minY = pt.y;
            if (pt.y > maxY) maxY = pt.y;
        }
        // clamp to domain
        minY = Math.max(0, minY);
        maxY = Math.min(this.ydim - 1, maxY);

        // 2. For each y, find x-intersections
        for (let y = minY; y <= maxY; y++) {
            const xIntersections = [];
            for (let i = 0; i < polygon.length; i++) {
                const p1 = polygon[i];
                const p2 = polygon[(i+1) % polygon.length];
                // check if line (p1->p2) crosses horizontal line at y
                if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
                    const dy = p2.y - p1.y;
                    const t = (y - p1.y) / dy;
                    const xInt = p1.x + (p2.x - p1.x) * t;
                    xIntersections.push(Math.round(xInt));
                }
            }
            xIntersections.sort((a,b)=>a-b);

            // 3. fill pairs of intersections
            for (let k = 0; k < xIntersections.length - 1; k += 2) {
                const xStart = xIntersections[k];
                const xEnd   = xIntersections[k+1];
                for (let x = xStart; x <= xEnd; x++) {
                    if (x >= 0 && x < this.xdim) {
                        barrierArray[x + y*this.xdim] = 1;
                    }
                }
            }
        }
    }

    // Zero out fluid in barrier cells
    _zeroOutBarrierCells() {
        for (let i = 0; i < this.barriers.length; i++) {
            if (this.barriers[i] === 1) {
                this.n0[i]  = 0;  
                this.nN[i]  = 0;  
                this.nS[i]  = 0;
                this.nE[i]  = 0;  
                this.nW[i]  = 0;  
                this.nNE[i] = 0;
                this.nSE[i] = 0;  
                this.nNW[i] = 0;  
                this.nSW[i] = 0;

                this.rho[i] = 0; 
                this.ux[i]  = 0;  
                this.uy[i]  = 0;
            }
        }
    }

    setBoundaryConditions() {
        const cosA = Math.cos(this.flowAngle);
        const sinA = Math.sin(this.flowAngle);
    
        // Handle both inlet and outlet with consistent velocity
        if (cosA >= 0) {
            // Left to right flow
            for (let y = 0; y < this.ydim; y++) {
                // Left boundary (inlet) - fixed density
                this.setEquilibrium(0, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
                
                // Right boundary (outlet) - maintain velocity but let density adjust
                const i2 = (this.xdim - 2) + y * this.xdim;
                const rhoOut = this.computeDensity(i2);
                this.setEquilibrium(this.xdim - 1, y, this.flowSpeed * cosA, this.flowSpeed * sinA, rhoOut);
            }
        } else {
            // Right to left flow
            for (let y = 0; y < this.ydim; y++) {
                // Right boundary (inlet) - fixed density
                this.setEquilibrium(this.xdim - 1, y, this.flowSpeed * cosA, this.flowSpeed * sinA, 1);
                
                // Left boundary (outlet) - maintain velocity but let density adjust
                const i2 = 1 + y * this.xdim;
                const rhoOut = this.computeDensity(i2);
                this.setEquilibrium(0, y, this.flowSpeed * cosA, this.flowSpeed * sinA, rhoOut);
            }
        }
    
        // Free-slip top/bottom boundaries
        for (let x = 0; x < this.xdim; x++) {
            const iTop = x + (this.ydim - 1) * this.xdim;
            const i2   = x + (this.ydim - 2) * this.xdim;
            this.n0[iTop]  = this.n0[i2];
            this.nE[iTop]  = this.nE[i2];
            this.nW[iTop]  = this.nW[i2];
            this.nN[iTop]  = this.nS[i2]; // Reflect normal component
            this.nS[iTop]  = this.nN[i2]; // Reflect normal component
            this.nNE[iTop] = this.nSE[i2]; // Reflect normal component
            this.nNW[iTop] = this.nSW[i2]; // Reflect normal component
            this.nSE[iTop] = this.nNE[i2]; // Reflect normal component
            this.nSW[iTop] = this.nNW[i2]; // Reflect normal component
        }
        for (let x = 0; x < this.xdim; x++) {
            const iBot = x + 0 * this.xdim;
            const i2   = x + 1 * this.xdim;
            this.n0[iBot]  = this.n0[i2];
            this.nE[iBot]  = this.nE[i2];
            this.nW[iBot]  = this.nW[i2];
            this.nN[iBot]  = this.nS[i2]; // Reflect normal component
            this.nS[iBot]  = this.nN[i2]; // Reflect normal component
            this.nNE[iBot] = this.nSE[i2]; // Reflect normal component
            this.nNW[iBot] = this.nSW[i2]; // Reflect normal component
            this.nSE[iBot] = this.nNE[i2]; // Reflect normal component
            this.nSW[iBot] = this.nNW[i2]; // Reflect normal component
        }
    }

    collide() {
        // Use Multi-Relaxation Time if enabled, otherwise fallback to standard BGK
        if (this.useMRT) {
            this.collideMRT();
        } else {
            this.collideBGK();
        }
    }
    
    // Standard BGK collision (Single Relaxation Time)
    collideBGK() {
        const omega = 1 / (3 * this.viscosity + 0.5);

        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) continue;

                const thisrho =
                    this.n0[i] + this.nN[i] + this.nS[i] + this.nE[i] + this.nW[i] +
                    this.nNW[i] + this.nNE[i] + this.nSW[i] + this.nSE[i];

                const thisux =
                    (this.nE[i] + this.nNE[i] + this.nSE[i]) -
                    (this.nW[i] + this.nNW[i] + this.nSW[i]);

                const thisuy =
                    (this.nN[i] + this.nNE[i] + this.nNW[i]) -
                    (this.nS[i] + this.nSE[i] + this.nSW[i]);

                const ux = thisux / thisrho;
                const uy = thisuy / thisrho;
                this.rho[i] = thisrho;
                this.ux[i]  = ux;
                this.uy[i]  = uy;
                
                // Calculate pressure (p = rho * cs^2 where cs^2 = 1/3 in LBM units)
                this.pressure[i] = thisrho / 3;

                const one9thrho  = this.one9th  * thisrho;
                const one36thrho = this.one36th * thisrho;
                const ux3 = 3 * ux;
                const uy3 = 3 * uy;
                const ux2 = ux * ux;
                const uy2 = uy * uy;
                const uxuy2 = 2 * ux * uy;
                const u2 = ux2 + uy2;
                const u215 = 1.5 * u2;

                this.n0[i]  += omega * (this.four9ths * thisrho * (1 - u215) - this.n0[i]);
                this.nE[i]  += omega * (one9thrho * (1 + ux3 + 4.5*ux2 - u215) - this.nE[i]);
                this.nW[i]  += omega * (one9thrho * (1 - ux3 + 4.5*ux2 - u215) - this.nW[i]);
                this.nN[i]  += omega * (one9thrho * (1 + uy3 + 4.5*uy2 - u215) - this.nN[i]);
                this.nS[i]  += omega * (one9thrho * (1 - uy3 + 4.5*uy2 - u215) - this.nS[i]);
                this.nNE[i] += omega * (one36thrho * (1 + ux3 + uy3 + 4.5*(u2 + uxuy2) - u215) - this.nNE[i]);
                this.nSE[i] += omega * (one36thrho * (1 + ux3 - uy3 + 4.5*(u2 - uxuy2) - u215) - this.nSE[i]);
                this.nNW[i] += omega * (one36thrho * (1 - ux3 + uy3 + 4.5*(u2 - uxuy2) - u215) - this.nNW[i]);
                this.nSW[i] += omega * (one36thrho * (1 - ux3 - uy3 + 4.5*(u2 + uxuy2) - u215) - this.nSW[i]);
            }
        }
    }
    
    // Multi-Relaxation Time collision operator
    collideMRT() {
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) continue;

                // Distribution functions at this node
                const f = [
                    this.n0[i], this.nE[i], this.nN[i], this.nW[i], this.nS[i],
                    this.nNE[i], this.nNW[i], this.nSW[i], this.nSE[i]
                ];
                
                // 1. Calculate macroscopic quantities
                const thisrho = f.reduce((sum, val) => sum + val, 0);
                const thisux = (f[1] + f[5] + f[8] - f[3] - f[6] - f[7]) / thisrho;
                const thisuy = (f[2] + f[5] + f[6] - f[4] - f[7] - f[8]) / thisrho;
                
                // Store in grid
                this.rho[i] = thisrho;
                this.ux[i] = thisux;
                this.uy[i] = thisuy;
                this.pressure[i] = thisrho / 3; // p = rho * cs^2 (cs^2 = 1/3)
                
                // 2. Transform to moment space: m = M·f
                const m = new Array(9).fill(0);
                for (let a = 0; a < 9; a++) {
                    for (let b = 0; b < 9; b++) {
                        m[a] += this.M[a][b] * f[b];
                    }
                }
                
                // 3. Calculate equilibrium moments
                const ux2 = thisux * thisux;
                const uy2 = thisuy * thisuy;
                const u2 = ux2 + uy2;
                
                const meq = [
                    thisrho,                  // Density (conserved)
                    -2*thisrho + 3*thisrho*u2, // Energy
                    thisrho - 3*thisrho*u2,    // Energy squared
                    thisrho*thisux,           // x-momentum (conserved)
                    -2/3*thisrho*thisux,      // x-energy flux
                    thisrho*thisuy,           // y-momentum (conserved)
                    -2/3*thisrho*thisuy,      // y-energy flux
                    thisrho*(ux2 - uy2),      // Diagonal stress
                    thisrho*thisux*thisuy     // Off-diagonal stress
                ];
                
                // 4. Collision in moment space: m' = m - S·(m - meq)
                const m_post = new Array(9);
                for (let a = 0; a < 9; a++) {
                    m_post[a] = m[a] - this.S[a] * (m[a] - meq[a]);
                }
                
                // 5. Transform back to distribution space: f' = M^-1·m'
                const f_post = new Array(9).fill(0);
                for (let a = 0; a < 9; a++) {
                    for (let b = 0; b < 9; b++) {
                        f_post[a] += this.Minv[a][b] * m_post[b];
                    }
                }
                
                // 6. Store updated distributions
                this.n0[i]  = f_post[0];
                this.nE[i]  = f_post[1];
                this.nN[i]  = f_post[2];
                this.nW[i]  = f_post[3];
                this.nS[i]  = f_post[4];
                this.nNE[i] = f_post[5];
                this.nNW[i] = f_post[6];
                this.nSW[i] = f_post[7];
                this.nSE[i] = f_post[8];
            }
        }
    }

    stream() {
        // Stream north-moving
        for (let y = this.ydim - 2; y > 0; y--) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                const iN = x + (y-1) * this.xdim;
                const iNW = (x+1) + (y-1) * this.xdim;
                const iNE = (x-1) + (y-1) * this.xdim;
                
                this.nN[i]  = this.nN[iN];
                this.nNW[i] = this.nNW[iNW];
                this.nNE[i] = this.nNE[iNE];
            }
        }
        // Stream south-moving
        for (let y = 0; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                const iS = x + (y+1) * this.xdim;
                const iSW = (x+1) + (y+1) * this.xdim;
                const iSE = (x-1) + (y+1) * this.xdim;
                
                this.nS[i]  = this.nS[iS];
                this.nSW[i] = this.nSW[iSW];
                this.nSE[i] = this.nSE[iSE];
            }
        }
        // Stream east/west
        for (let y = 1; y < this.ydim - 1; y++) {
            // Stream east (right to left)
            for (let x = 0; x < this.xdim - 1; x++) {
                this.nE[x + y*this.xdim] = this.nE[(x+1) + y*this.xdim];
            }
            // Stream west (left to right)
            for (let x = this.xdim - 1; x > 0; x--) {
                this.nW[x + y*this.xdim] = this.nW[(x-1) + y*this.xdim];
            }
        }
        
        // Bounce-back from barriers
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                if (this.barriers[x + y*this.xdim]) {
                    const i = x + y*this.xdim;
                    
                    // Bounce back for each direction (half-way bounce-back)
                    // For enhanced numerical stability
                    const xE = x+1, xW = x-1, yN = y-1, yS = y+1;
                    
                    // East/West
                    [this.nE[xE + y*this.xdim], this.nW[i]] = [this.nW[i], this.nE[xE + y*this.xdim]];
                    
                    // North/South
                    [this.nN[x + yN*this.xdim], this.nS[i]] = [this.nS[i], this.nN[x + yN*this.xdim]];
                    
                    // Diagonals
                    [this.nNE[xE + yN*this.xdim], this.nSW[i]] = [this.nSW[i], this.nNE[xE + yN*this.xdim]];
                    [this.nNW[xW + yN*this.xdim], this.nSE[i]] = [this.nSE[i], this.nNW[xW + yN*this.xdim]];
                }
            }
        }
    }

    computeSpeed() {
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                const i = x + y * this.xdim;
                const vx = this.ux[i];
                const vy = this.uy[i];
                this.speed[i] = Math.sqrt(vx*vx + vy*vy);
            }
        }
    }

    computeCurl() {
        // Compute curl (vorticity) as ∂uy/∂x - ∂ux/∂y using central differences
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                
                // Central difference for ∂uy/∂x
                const duy_dx = (this.uy[x + 1 + y * this.xdim] - this.uy[x - 1 + y * this.xdim]) / 2.0;
                
                // Central difference for ∂ux/∂y
                const dux_dy = (this.ux[x + (y + 1) * this.xdim] - this.ux[x + (y - 1) * this.xdim]) / 2.0;
                
                this.curl[i] = duy_dx - dux_dy;
            }
        }
    }

    // Calculate lift and drag forces on the airfoil
    calculateForces() {
        // Initialize forces
        let fx = 0;
        let fy = 0;
        
        // Flow angle for force projection
        const angleRad = this.flowAngle;
        const cosA = Math.cos(angleRad);
        const sinA = Math.sin(angleRad);
        
        // Loop through domain
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                
                // Only process barrier cells
                if (!this.barriers[i]) continue;
                
                // Check if this is a boundary cell by looking at neighbors
                let isBoundary = false;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        
                        const nx = x + dx;
                        const ny = y + dy;
                        
                        if (nx >= 0 && nx < this.xdim && 
                            ny >= 0 && ny < this.ydim &&
                            !this.barriers[nx + ny * this.xdim]) {
                            isBoundary = true;
                            break;
                        }
                    }
                    if (isBoundary) break;
                }
                
                if (!isBoundary) continue;
                
                // Calculate pressure forces from neighboring fluid cells
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        
                        const nx = x + dx;
                        const ny = y + dy;
                        
                        if (nx >= 0 && nx < this.xdim && 
                            ny >= 0 && ny < this.ydim &&
                            !this.barriers[nx + ny * this.xdim]) {
                            
                            // Get pressure from fluid cell
                            const fluidIdx = nx + ny * this.xdim;
                            const p = this.pressure[fluidIdx];
                            
                            // Apply force in direction from barrier to fluid
                            const length = Math.sqrt(dx*dx + dy*dy);
                            const nx = dx / length; // Force direction x
                            const ny = dy / length; // Force direction y
                            
                            // Magnitude proportional to pressure and area (using equal areas)
                            const forceMag = p;
                            
                            // Add to total force
                            fx += forceMag * nx;
                            fy += forceMag * ny;
                        }
                    }
                }
            }
        }
        
        // Project forces to get lift and drag
        // Lift is perpendicular to flow, drag is parallel to flow
        const drag = fx * cosA + fy * sinA;
        const lift = -fx * sinA + fy * cosA;
        
        // Normalize by reference values
        const rho0 = 1.0; // Reference density
        const vel0 = this.flowSpeed; // Reference velocity
        const areaRef = this.chordLength; // Reference area (chord length in 2D)
        
        const normFactor = 0.5 * rho0 * vel0 * vel0 * areaRef;
        
        this.forces = {
            fx, fy,
            drag: drag / normFactor,
            lift: lift / normFactor,
            cl: lift / normFactor, // Lift coefficient
            cd: drag / normFactor  // Drag coefficient
        };
        
        return this.forces;
    }

    // Generate streamlines for visualization
    generateStreamlines() {
        // Clear existing streamlines
        this.streamlines = [];
        
        // Number of streamlines to generate
        const numLines = 20;
        
        // Generate seed points along the left edge (for left-to-right flow)
        // or right edge (for right-to-left flow)
        const startX = (Math.cos(this.flowAngle) >= 0) ? 5 : this.xdim - 5;
        
        for (let i = 0; i < numLines; i++) {
            // Distribute seed points vertically
            const startY = (i + 0.5) * this.ydim / numLines;
            
            // Create a new streamline
            const streamline = this._traceStreamline(startX, startY);
            if (streamline.length > 2) {
                this.streamlines.push(streamline);
            }
        }
    }
    
    // Trace a single streamline from a starting point
    _traceStreamline(startX, startY) {
        const points = [];
        let x = startX;
        let y = startY;
        
        // Maximum number of steps
        const maxSteps = 500;
        
        // Step size (smaller for accuracy, larger for speed)
        const dt = 0.5;
        
        for (let step = 0; step < maxSteps; step++) {
            // Add current point
            points.push({ x, y });
            
            // Interpolate velocity at current position
            const vx = this._interpolateField(x, y, this.ux);
            const vy = this._interpolateField(x, y, this.uy);
            
            // Check if we've reached low velocity or a boundary
            const speed = Math.sqrt(vx*vx + vy*vy);
            if (speed < 0.01 || this._isInBarrier(x, y) || 
                x <= 0 || x >= this.xdim - 1 || y <= 0 || y >= this.ydim - 1) {
                break;
            }
            
            // RK4 integration for better accuracy
            const k1x = vx;
            const k1y = vy;
            
            const x2 = x + k1x * dt/2;
            const y2 = y + k1y * dt/2;
            const k2x = this._interpolateField(x2, y2, this.ux);
            const k2y = this._interpolateField(x2, y2, this.uy);
            
            const x3 = x + k2x * dt/2;
            const y3 = y + k2y * dt/2;
            const k3x = this._interpolateField(x3, y3, this.ux);
            const k3y = this._interpolateField(x3, y3, this.uy);
            
            const x4 = x + k3x * dt;
            const y4 = y + k3y * dt;
            const k4x = this._interpolateField(x4, y4, this.ux);
            const k4y = this._interpolateField(x4, y4, this.uy);
            
            // Update position using RK4
            x += (k1x + 2*k2x + 2*k3x + k4x) * dt / 6;
            y += (k1y + 2*k2y + 2*k3y + k4y) * dt / 6;
        }
        
        return points;
    }
    
    // Bilinear interpolation of a field at (x,y)
    _interpolateField(x, y, field) {
        // Get integer coordinates
        const x1 = Math.floor(x);
        const y1 = Math.floor(y);
        const x2 = Math.min(x1 + 1, this.xdim - 1);
        const y2 = Math.min(y1 + 1, this.ydim - 1);
        
        // Fractional part
        const fx = x - x1;
        const fy = y - y1;
        
        // Values at the four corners
        const v11 = field[x1 + y1 * this.xdim];
        const v21 = field[x2 + y1 * this.xdim];
        const v12 = field[x1 + y2 * this.xdim];
        const v22 = field[x2 + y2 * this.xdim];
        
        // Bilinear interpolation
        return (1-fx)*(1-fy)*v11 + fx*(1-fy)*v21 + (1-fx)*fy*v12 + fx*fy*v22;
    }
    
    // Check if a point is inside a barrier
    _isInBarrier(x, y) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        
        if (ix < 0 || ix >= this.xdim || iy < 0 || iy >= this.ydim) {
            return false;
        }
        
        return this.barriers[ix + iy * this.xdim] === 1;
    }

    draw() {
        // Update physics fields
        this.computeSpeed();
        this.computeCurl();
        
        // Select color map based on visualization mode
        let activeColors;
        let fieldToVisualize;
        let scale;
        
        switch (this.visualizationMode) {
            case 'curl':
                activeColors = this.curlColors;
                fieldToVisualize = this.curl;
                scale = 20.0; // Adjust for curl sensitivity
                break;
            case 'pressure':
                activeColors = this.pressureColors;
                fieldToVisualize = this.pressure;
                scale = 10.0; // Adjust for pressure sensitivity
                break;
            case 'speed':
            default:
                activeColors = this.speedColors;
                fieldToVisualize = this.speed;
                scale = 1200; // Maintain original speed scaling
                break;
        }
        
        // Render field
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                const i = x + y * this.xdim;
                
                if (this.barriers[i]) {
                    // Render barrier in white
                    this.fillSquare(x, y, 255, 255, 255);
                    continue;
                }
    
                // Map field value to color
                const fieldValue = fieldToVisualize[i];
                let colorIndex;
                
                // Different mapping for curl (which can be positive or negative)
                if (this.visualizationMode === 'curl') {
                    colorIndex = Math.floor((fieldValue * scale + 0.5) * this.nColors);
                } else {
                    colorIndex = Math.floor(fieldValue * scale);
                }
                
                colorIndex = Math.max(0, Math.min(this.nColors - 1, colorIndex));
                const c = activeColors[colorIndex];
                this.fillSquare(x, y, c.r, c.g, c.b);
            }
        }
        
        // Put the simulation pixels onto the canvas
        this.ctx.putImageData(this.imageData, 0, 0);
        
        // Draw streamlines if enabled
        if (this.showStreamlines) {
            // Generate new streamlines every few frames for a dynamic effect
            if (this.frameCount % 30 === 0) {
                this.generateStreamlines();
            }
            this.drawStreamlines();
        }
        
        // Draw force vectors if enabled
        if (this.showForceVectors) {
            if (this.frameCount % this.forceUpdateInterval === 0) {
                this.calculateForces();
            }
            this.drawForceVectors();
        }
        
        // Draw legend
        this.drawLegend();
        
        // Draw physics info
        this.drawPhysicsInfo();
        
        // Increment frame counter
        this.frameCount++;
    }
    
    drawLegend() {
        // Draw a color legend at the bottom of the screen
        const legendHeight = 15;
        const startY = this.height - legendHeight - 25;
        const startX = 20;
        const width = 150;
        
        // Background
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(startX - 5, startY - 5, width + 65, legendHeight + 25);
        
        // Title based on current visualization mode
        this.ctx.fillStyle = 'white';
        this.ctx.font = '12px Arial';
        let title;
        switch (this.visualizationMode) {
            case 'curl': title = 'Vorticity'; break;
            case 'pressure': title = 'Pressure'; break;
            case 'speed': title = 'Velocity'; break;
        }
        this.ctx.fillText(title, startX, startY - 10);
        
        // Draw the gradient
        const colors = this.visualizationMode === 'curl' ? this.curlColors : 
                      this.visualizationMode === 'pressure' ? this.pressureColors : 
                      this.speedColors;
                      
        const step = width / colors.length;
        for (let i = 0; i < colors.length; i++) {
            const x = startX + i * step;
            const c = colors[i];
            this.ctx.fillStyle = `rgb(${c.r}, ${c.g}, ${c.b})`;
            this.ctx.fillRect(x, startY, step + 1, legendHeight);
        }
        
        // Draw min/max labels
        this.ctx.fillStyle = 'white';
        this.ctx.textAlign = 'left';
        
        if (this.visualizationMode === 'curl') {
            this.ctx.fillText('Low', startX, startY + legendHeight + 15);
            this.ctx.textAlign = 'center';
            this.ctx.fillText('0', startX + width/2, startY + legendHeight + 15);
            this.ctx.textAlign = 'right';
            this.ctx.fillText('High', startX + width, startY + legendHeight + 15);
        } else {
            this.ctx.fillText('Low', startX, startY + legendHeight + 15);
            this.ctx.textAlign = 'right';
            this.ctx.fillText('High', startX + width, startY + legendHeight + 15);
        }
    }
    
    drawPhysicsInfo() {
        // Display Reynolds number and force coefficients
        const infoX = this.width - 200;
        const infoY = 30;
        
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(infoX - 10, infoY - 25, 190, 80);
        
        this.ctx.fillStyle = 'white';
        this.ctx.font = 'bold 12px Arial';
        this.ctx.textAlign = 'left';
        this.ctx.fillText('Physics Data:', infoX, infoY - 10);
        
        this.ctx.font = '12px Arial';
        this.ctx.fillText(`Reynolds: ${Math.round(this.reynoldsNumber)}`, infoX, infoY + 10);
        this.ctx.fillText(`CL: ${this.forces.cl.toFixed(3)}`, infoX, infoY + 30);
        this.ctx.fillText(`CD: ${this.forces.cd.toFixed(3)}`, infoX, infoY + 50);
    }
    
    drawStreamlines() {
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        this.ctx.lineWidth = 1;
        
        for (const line of this.streamlines) {
            if (line.length < 2) continue;
            
            this.ctx.beginPath();
            // Convert from grid to canvas coordinates
            // Also flip Y coordinate since canvas Y is down but our simulation Y is up
            const startX = line[0].x * this.pxPerSquare;
            const startY = (this.ydim - line[0].y) * this.pxPerSquare;
            this.ctx.moveTo(startX, startY);
            
            for (let i = 1; i < line.length; i++) {
                const x = line[i].x * this.pxPerSquare;
                const y = (this.ydim - line[i].y) * this.pxPerSquare;
                this.ctx.lineTo(x, y);
            }
            
            this.ctx.stroke();
        }
    }
    
    drawForceVectors() {
        const airfoil = this.airfoilData;
        if (!airfoil) return;
        
        // Scale force vectors for visibility
        const forceScale = 10000;
        
        // Center of airfoil (approximate)
        const centerX = airfoil.centerX * this.pxPerSquare;
        const centerY = (this.ydim - airfoil.centerY) * this.pxPerSquare;
        
        // Draw lift vector (perpendicular to flow)
        const liftAngle = this.flowAngle + Math.PI/2;
        const liftX = centerX + Math.cos(liftAngle) * this.forces.lift * forceScale;
        const liftY = centerY - Math.sin(liftAngle) * this.forces.lift * forceScale;
        
        this.ctx.beginPath();
        this.ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
        this.ctx.lineWidth = 2;
        this.ctx.moveTo(centerX, centerY);
        this.ctx.lineTo(liftX, liftY);
        
        // Draw arrowhead
        const arrowLength = 10;
        const arrowAngle = Math.PI/8;
        this.ctx.lineTo(
            liftX - arrowLength * Math.cos(liftAngle - arrowAngle),
            liftY + arrowLength * Math.sin(liftAngle - arrowAngle)
        );
        this.ctx.moveTo(liftX, liftY);
        this.ctx.lineTo(
            liftX - arrowLength * Math.cos(liftAngle + arrowAngle),
            liftY + arrowLength * Math.sin(liftAngle + arrowAngle)
        );
        this.ctx.stroke();
        
        // Draw drag vector (parallel to flow)
        const dragX = centerX + Math.cos(this.flowAngle) * this.forces.drag * forceScale;
        const dragY = centerY - Math.sin(this.flowAngle) * this.forces.drag * forceScale;
        
        this.ctx.beginPath();
        this.ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
        this.ctx.lineWidth = 2;
        this.ctx.moveTo(centerX, centerY);
        this.ctx.lineTo(dragX, dragY);
        
        // Draw arrowhead
        this.ctx.lineTo(
            dragX - arrowLength * Math.cos(this.flowAngle - arrowAngle),
            dragY + arrowLength * Math.sin(this.flowAngle - arrowAngle)
        );
        this.ctx.moveTo(dragX, dragY);
        this.ctx.lineTo(
            dragX - arrowLength * Math.cos(this.flowAngle + arrowAngle),
            dragY + arrowLength * Math.sin(this.flowAngle + arrowAngle)
        );
        this.ctx.stroke();
        
        // Label the vectors
        this.ctx.fillStyle = 'white';
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('Lift', liftX + 10, liftY);
        this.ctx.fillText('Drag', dragX + 10, dragY);
    }
        
    fillSquare(x, y, r, g, b) {
        const flippedY = this.ydim - y - 1;
        for (let py = flippedY * this.pxPerSquare; py < (flippedY + 1) * this.pxPerSquare; py++) {
            for (let px = x * this.pxPerSquare; px < (x + 1) * this.pxPerSquare; px++) {
                const idx = (px + py * this.width) * 4;
                this.imageData.data[idx]   = r;
                this.imageData.data[idx+1] = g;
                this.imageData.data[idx+2] = b;
                this.imageData.data[idx+3] = 255;
            }
        }
    }

    update() {
        if (!this.running) return;
    
        try {
            const stepsPerFrame = 5;
            for (let step = 0; step < stepsPerFrame; step++) {
                this.setBoundaryConditions();
                this.collide();
                this.stream();
            }
    
            // Calculate forces every few frames for efficiency
            if (this.frameCount % this.forceUpdateInterval === 0) {
                this.calculateForces();
            }
    
            this.draw();
            requestAnimationFrame(() => this.update());
        } catch (error) {
            this.running = false;
            const statusMsg = document.getElementById('statusMessage');
            statusMsg.textContent = `Error: ${error.message}`;
            console.error('Simulation error:', error);
        }
    }

    resize(width, height) {
        this.canvas.width = Math.max(width, 600);
        this.canvas.height = Math.max(height, 400);
        this.width = this.canvas.width;
        this.height = this.canvas.height;

        this.xdim = Math.floor(this.width / this.pxPerSquare);
        this.ydim = Math.floor(this.height / this.pxPerSquare);
        if (this.xdim < 50) this.xdim = 50;
        if (this.ydim < 50) this.ydim = 50;

        this.initArrays();
        this.imageData = this.ctx.createImageData(this.width, this.height);
        for (let i = 3; i < this.imageData.data.length; i += 4) {
            this.imageData.data[i] = 255;
        }

        this.initFluid();
        this.addNACABarrier({
            chordFraction: 1/6,
            thickness: 0.12,
            angle: this.currentAngle
        });

        this.draw();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const container = document.querySelector('.home-image');
    if (!container) {
        console.error("No .home-image found");
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'simulation-canvas';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.backgroundColor = 'black';
    container.innerHTML = '';
    
    // Create controls container
    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'simulation-controls';
    controlsDiv.style.position = 'absolute';
    controlsDiv.style.bottom = '20px';
    controlsDiv.style.right = '20px';
    controlsDiv.style.backgroundColor = 'rgba(24, 27, 29, 0.8)';
    controlsDiv.style.padding = '15px';
    controlsDiv.style.borderRadius = '8px';
    controlsDiv.style.zIndex = '1000'; 
    controlsDiv.style.cursor = 'default';
    controlsDiv.style.width = '240px';
    controlsDiv.innerHTML = `
        <div style="text-align: center; margin-bottom: 15px;">
            <button id="playPauseButton" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white; margin-bottom: 15px; font-family: monospace;">
                Simulate
            </button>
            <div style="display: flex; justify-content: center; gap: 8px; margin-bottom: 10px;">
                <button id="viewSpeed" class="view-mode-btn active" style="padding: 5px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: #444; color: white;">Velocity</button>
                <button id="viewCurl" class="view-mode-btn" style="padding: 5px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">Vorticity</button>
                <button id="viewPressure" class="view-mode-btn" style="padding: 5px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">Pressure</button>
            </div>
            <div style="display: flex; justify-content: center; gap: 8px; margin-bottom: 15px;">
                <button id="toggleStreamlines" style="padding: 5px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">Streamlines</button>
                <button id="toggleForces" style="padding: 5px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">Forces</button>
            </div>
        </div>
        <div style="display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;">
            <button id="increaseAngle" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">↓</button>
            <div id="angleDisplay" style="font-family: monospace; min-width: 80px; text-align: center;"></div>
            <button id="decreaseAngle" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">↑</button>
        </div>
        <div id="statusMessage" style="text-align: left; margin-top: 10px; font-family: monospace; color: #aaa;"></div>
    `;
    
    container.appendChild(canvas);
    container.appendChild(controlsDiv);

    const rect = container.getBoundingClientRect();
    canvas.width = Math.max(Math.floor(rect.width), 600);
    canvas.height = Math.max(Math.floor(rect.height), 400);

    // Create simulation with improved settings
    const simulation = new FluidSimulation(canvas, {
        pxPerSquare: 2,
        flowSpeed: 0.225,
        flowAngleDeg: 0,
        viscosity: 0.02  // Lower viscosity for higher Reynolds number
    });
    
    canvas.classList.add('initialized');

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const controls = document.querySelector('.simulation-controls');
            if (entry.isIntersecting) {
                controls.style.opacity = '1';
                controls.style.visibility = 'visible';
            } else {
                controls.style.opacity = '0';
                controls.style.visibility = 'hidden';
            }
        });
    }, { threshold: 0.1 });
    
    document.getElementById('statusMessage').textContent = 'Status: Domain Initalized';

    observer.observe(canvas);

    // Set up angle control handlers
    const stepSize = 0.0872665; // 5 degrees
    const angleDisplay = document.getElementById('angleDisplay');
    const updateAngleDisplay = () => {
        const degrees = (simulation.currentAngle * 180 / Math.PI).toFixed(1);
        angleDisplay.innerHTML = `Angle of Attack<br>${degrees*-1}°`;
    };
    updateAngleDisplay();

    document.getElementById('increaseAngle').addEventListener('click', () => {
        simulation.updateAngle(simulation.currentAngle + stepSize);
        updateAngleDisplay();
        if (!simulation.running) {
            simulation.running = true;
            simulation.update();
            document.getElementById('playPauseButton').textContent = 'Pause';
            document.getElementById('statusMessage').textContent = 'Status: Solving LBM Model';
        }
    });
    
    document.getElementById('decreaseAngle').addEventListener('click', () => {
        simulation.updateAngle(simulation.currentAngle - stepSize);
        updateAngleDisplay();
        if (!simulation.running) {
            simulation.running = true;
            simulation.update();
            document.getElementById('playPauseButton').textContent = 'Pause';
            document.getElementById('statusMessage').textContent = 'Status: Solving LBM Model';
        }
    });

    // Play/pause event listener
    document.getElementById('playPauseButton').addEventListener('click', () => {
        simulation.running = !simulation.running;
        const button = document.getElementById('playPauseButton');
        const statusMsg = document.getElementById('statusMessage');
        button.textContent = simulation.running ? 'Pause' : 'Simulate';
        statusMsg.textContent = simulation.running ? 'Status: Solving LBM Model' : 'Status: Paused';
        if (simulation.running) {
            simulation.update();
        }
    });
    
    // View mode buttons
    const setActiveViewButton = (activeId) => {
        document.querySelectorAll('.view-mode-btn').forEach(btn => {
            if (btn.id === activeId) {
                btn.style.background = '#444';
                btn.style.color = 'white';
            } else {
                btn.style.background = 'white';
                btn.style.color = 'black';
            }
        });
    };
    
    document.getElementById('viewSpeed').addEventListener('click', () => {
        simulation.setVisualizationMode('speed');
        setActiveViewButton('viewSpeed');
    });
    
    document.getElementById('viewCurl').addEventListener('click', () => {
        simulation.setVisualizationMode('curl');
        setActiveViewButton('viewCurl');
    });
    
    document.getElementById('viewPressure').addEventListener('click', () => {
        simulation.setVisualizationMode('pressure');
        setActiveViewButton('viewPressure');
    });
    
    // Toggle streamlines
    document.getElementById('toggleStreamlines').addEventListener('click', () => {
        simulation.toggleStreamlines();
        const btn = document.getElementById('toggleStreamlines');
        if (simulation.showStreamlines) {
            btn.style.background = '#444';
            btn.style.color = 'white';
        } else {
            btn.style.background = 'white';
            btn.style.color = 'black';
        }
    });
    
    // Toggle force vectors
    document.getElementById('toggleForces').addEventListener('click', () => {
        simulation.toggleForceVectors();
        const btn = document.getElementById('toggleForces');
        if (simulation.showForceVectors) {
            btn.style.background = '#444';
            btn.style.color = 'white';
        } else {
            btn.style.background = 'white';
            btn.style.color = 'black';
        }
    });

    // Debounced resize handler
    let resizeTimeout;
    window.addEventListener('resize', () => {
        if (resizeTimeout) {
            clearTimeout(resizeTimeout);
        }
        resizeTimeout = setTimeout(() => {
            const r = container.getBoundingClientRect();
            simulation.resize(Math.floor(r.width), Math.floor(r.height));
        }, 250);
    });
});