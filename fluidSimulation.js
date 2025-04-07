// fluidSimulation.js //

class FluidSimulation {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.hasInitialized = false;
        this.options = options;
        this.currentAngle = -0.261799; 

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

        // Simulation parameters
        this.flowSpeed = options.flowSpeed || 0.3;
        this.flowAngle = (options.flowAngleDeg || 0) * Math.PI / 180;
        this.viscosity = options.viscosity || 0.01;
        this.running = false;
        
        // Airfoil parameters
        this.airfoilCamber = 0.05;
        this.airfoilThickness = 0.22;
        
        // Stability parameters
        this.maxAllowedSpeed = 0.5; 
        this.minAllowedDensity = 0.1;
        this.stabilityCorrections = 0;
        
        // Diagnostic variables
        this.maxSpeed = 0;
        this.minDensity = 1.0;
        this.reynoldsNumber = 0;

        // Arrays
        this.initArrays();

        // imageData for rendering
        this.imageData = this.ctx.createImageData(this.width, this.height);
        for (let i = 3; i < this.imageData.data.length; i += 4) {
            this.imageData.data[i] = 255;
        }

        // Initialize color map
        this.initColors();

        // 1) Initialize domain at rest
        this.initFluid();

        // 2) Add the airfoil barrier (polygon fill)
        this.addNACABarrier({
            chordFraction: 1/3,
            thickness: this.airfoilThickness,
            angle: this.currentAngle,
            camber: this.airfoilCamber,
            camberPos: 0.4
        });

        // 3) Start simulation
        this.draw();  // Draw the initial state regardless of running
        if (this.running) {
            this.update();
        }
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

        this.speed = new Float32Array(size);
        
        // Boundary distance field for interpolated bounce-back
        this.distanceField = new Float32Array(size);
        
        this.barriers = new Uint8Array(size);
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
            }
        }
    
        for (let i = 0; i < this.curl.length; i++) {
            this.curl[i] = 0.0;
        }
        
        // Initialize distance field with maximum value
        for (let i = 0; i < this.distanceField.length; i++) {
            this.distanceField[i] = 1.0;
        }

        // Zero out any velocities in barrier cells
        this._zeroOutBarrierCells();
    }

    updateAngle(newAngle) {
        this.currentAngle = newAngle;
        this.initArrays();
        this.initFluid();
        this.addNACABarrier({
            chordFraction: 1/3.5,
            thickness: this.airfoilThickness,
            angle: this.currentAngle,
            camber: this.airfoilCamber,
            camberPos: 0.4
        });
        
        // Reset diagnostic values
        this.stabilityCorrections = 0;
        this.maxSpeed = 0;
        this.minDensity = 1.0;
    }

    // Classic rainbow CFD colormap with tighter high-speed range
    initColors() {
        this.nColors = 80;
        this.colors = new Array(this.nColors);
        
        // Standard rainbow spectrum for CFD visualization
        // Adjusted to reserve red only for highest speeds
        for (let i = 0; i < this.nColors; i++) {
            const phase = i / this.nColors;
            let r, g, b;

            if (phase < 0.15) {              
                r = 0;
                g = 0;
                b = 128 + Math.round(127 * (phase / 0.15));
            } else if (phase < 0.3) {                
                r = 0;
                g = Math.round(255 * ((phase - 0.15) / 0.15));
                b = 255;
            } else if (phase < 0.55) {                
                r = 0;
                g = 255;
                b = 255 - Math.round(255 * ((phase - 0.3) / 0.25));
            } else if (phase < 0.75) {                
                r = Math.round(255 * ((phase - 0.55) / 0.2));
                g = 255;
                b = 0;
            } else if (phase < 0.92) {                
                r = 255;
                g = 255 - Math.round(195 * ((phase - 0.75) / 0.17));
                b = 0;
            } else {                
                r = 255;
                g = 60 - Math.round(60 * ((phase - 0.92) / 0.08));
                b = 0;
            }
            this.colors[i] = { r, g, b };
        }
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

    //  NACA airfoil generation
    addNACABarrier({ chordFraction = 1/3, thickness = 0.12, angle = 0, camber = 0.02, camberPos = 0.4 }) {
        const chordLength = Math.floor(this.xdim * chordFraction);
        // Position airfoil further upstream for better visualization of wake
        const centerX = Math.floor(this.xdim / 3);
        const centerY = Math.floor(this.ydim / 2);
        
        // Higher resolution sampling along chord
        const numPoints = Math.max(80, chordLength * 2);

        // NACA camber line function (for 4-digit NACA airfoils)
        const nacaCamber = (xFrac) => {
            if (xFrac <= camberPos) {
                return camber * (xFrac / camberPos**2) * (2 * camberPos - xFrac);
            } else {
                return camber * ((1 - xFrac) / (1 - camberPos)**2) * (1 + xFrac - 2 * camberPos);
            }
        };
        
        // NACA camber angle (dyc/dx)
        const nacaCamberSlope = (xFrac) => {
            if (xFrac <= camberPos) {
                return (2 * camber / camberPos**2) * (camberPos - xFrac);
            } else {
                return (2 * camber / (1 - camberPos)**2) * (camberPos - xFrac);
            }
        };

        // NACA thickness function
        const nacaThickness = (xFrac) => {
            // Avoid singularity at trailing edge
            if (xFrac > 0.9999) xFrac = 0.9999;
            
            return (thickness / 0.2) * chordLength * (
                0.2969 * Math.sqrt(xFrac) -
                0.1260 * xFrac -
                0.3516 * xFrac**2 +
                0.2843 * xFrac**3 -
                0.1015 * xFrac**4
            );
        };

        // Generate points with higher precision
        const topPoints = [];
        const botPoints = [];
        
        for (let i = 0; i <= numPoints; i++) {
            const xFrac = i / numPoints;
            const xC = xFrac * chordLength;
            
            // Calculate camber and thickness at this position
            const yc = nacaCamber(xFrac) * chordLength;
            const yt = nacaThickness(xFrac) / 2;
            const theta = Math.atan(nacaCamberSlope(xFrac));
            
            // Calculate upper and lower surface points
            const xu = xC - yt * Math.sin(theta);
            const yu = yc + yt * Math.cos(theta);
            
            const xl = xC + yt * Math.sin(theta);
            const yl = yc - yt * Math.cos(theta);
            
            // Apply rotation and translation
            const cosAng = Math.cos(angle);
            const sinAng = Math.sin(angle);
            
            // Top surface point (rotated and translated)
            const xTop = Math.round(centerX + xu * cosAng - yu * sinAng);
            const yTop = Math.round(centerY + xu * sinAng + yu * cosAng);
            
            // Bottom surface point (rotated and translated)
            const xBot = Math.round(centerX + xl * cosAng - yl * sinAng);
            const yBot = Math.round(centerY + xl * sinAng + yl * cosAng);
            
            topPoints.push({ x: xTop, y: yTop });
            botPoints.push({ x: xBot, y: yBot });
        }
        
        // Ensure sharp trailing edge
        const lastTop = topPoints[topPoints.length - 1];
        const lastBot = botPoints[botPoints.length - 1];
        
        // Force exact same trailing edge point
        const trailingX = Math.round((lastTop.x + lastBot.x) / 2);
        const trailingY = Math.round((lastTop.y + lastBot.y) / 2);
        
        topPoints[topPoints.length - 1] = { x: trailingX, y: trailingY };
        botPoints[botPoints.length - 1] = { x: trailingX, y: trailingY };

        // Build a closed polygon
        const polygon = this._buildAirfoilPolygon(topPoints, botPoints);

        // Fill polygon into this.barriers
        this._fillPolygon(polygon, this.barriers);
        
        // Generate distance field for interpolated bounce-back
        this._generateDistanceField(polygon);

        // Zero out fluid in all barrier cells
        this._zeroOutBarrierCells();
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
    
    // Generate distance field for interpolated bounce-back
    _generateDistanceField(polygon) {
        // Calculate distance from each fluid cell to the nearest boundary
        const distanceThreshold = 3; // Only compute precise distance for cells near boundaries
        
        // First, mark cells adjacent to barriers
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                
                if (!this.barriers[i]) {
                    // Check all 8 neighbors
                    for (let ny = y-1; ny <= y+1; ny++) {
                        for (let nx = x-1; nx <= x+1; nx++) {
                            if (nx >= 0 && nx < this.xdim && ny >= 0 && ny < this.ydim) {
                                const ni = nx + ny * this.xdim;
                                if (this.barriers[ni]) {
                                    // Find precise distance to polygon
                                    let minDist = distanceThreshold;
                                    
                                    // For nearby cells, compute precise distance to boundary
                                    for (let j = 0; j < polygon.length; j++) {
                                        const p1 = polygon[j];
                                        const p2 = polygon[(j+1) % polygon.length];
                                        
                                        // Distance to line segment
                                        const dist = this._distanceToLineSegment(x, y, p1.x, p1.y, p2.x, p2.y);
                                        minDist = Math.min(minDist, dist);
                                    }
                                    
                                    // Normalize distance (0 = boundary, 1 = far away)
                                    this.distanceField[i] = Math.min(this.distanceField[i], 
                                                                    minDist / distanceThreshold);
                                    break;
                                }
                            }
                        }
                    }
                } else {
                    // Inside barrier
                    this.distanceField[i] = 0;
                }
            }
        }
    }
    
    // Helper function to calculate distance from point to line segment
    _distanceToLineSegment(x, y, x1, y1, x2, y2) {
        const A = x - x1;
        const B = y - y1;
        const C = x2 - x1;
        const D = y2 - y1;
        
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) // To avoid division by zero
            param = dot / lenSq;
        
        let xx, yy;
        
        if (param < 0) {
            xx = x1;
            yy = y1;
        } else if (param > 1) {
            xx = x2;
            yy = y2;
        } else {
            xx = x1 + param * C;
            yy = y1 + param * D;
        }
        
        const dx = x - xx;
        const dy = y - yy;
        
        return Math.sqrt(dx * dx + dy * dy);
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
            this.nN[iTop]  = this.nN[i2];
            this.nS[iTop]  = this.nS[i2];
            this.nNE[iTop] = this.nNE[i2];
            this.nNW[iTop] = this.nNW[i2];
            this.nSE[iTop] = this.nSE[i2];
            this.nSW[iTop] = this.nSW[i2];
        }
        for (let x = 0; x < this.xdim; x++) {
            const iBot = x + 0 * this.xdim;
            const i2   = x + 1 * this.xdim;
            this.n0[iBot]  = this.n0[i2];
            this.nE[iBot]  = this.nE[i2];
            this.nW[iBot]  = this.nW[i2];
            this.nN[iBot]  = this.nN[i2];
            this.nS[iBot]  = this.nS[i2];
            this.nNE[iBot] = this.nNE[i2];
            this.nNW[iBot] = this.nNW[i2];
            this.nSE[iBot] = this.nSE[i2];
            this.nSW[iBot] = this.nSW[i2];
        }
    }

    // Collide function
    collide() {
        // Compute adaptive relaxation parameter based on flow conditions
        // Higher viscosity (more stable) for high-speed regions
        const baseOmega = 1 / (3 * this.viscosity + 0.5);
        
        let maxSpeed = 0;
        let minDensity = 1.0;
        let stabilityCorrections = 0;

        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y * this.xdim;
                if (this.barriers[i]) continue;

                // Compute macroscopic values (density and velocity)
                const thisrho =
                    this.n0[i] + this.nN[i] + this.nS[i] + this.nE[i] + this.nW[i] +
                    this.nNW[i] + this.nNE[i] + this.nSW[i] + this.nSE[i];

                // STABILITY CHECK 1: Detect abnormally low density
                if (thisrho < this.minAllowedDensity || isNaN(thisrho)) {
                    // Reset to equilibrium with reference values
                    this.setEquilibrium(x, y, this.flowSpeed * 0.8, 0, 1.0);
                    stabilityCorrections++;
                    continue;
                }

                const thisux =
                    (this.nE[i] + this.nNE[i] + this.nSE[i]) -
                    (this.nW[i] + this.nNW[i] + this.nSW[i]);

                const thisuy =
                    (this.nN[i] + this.nNE[i] + this.nNW[i]) -
                    (this.nS[i] + this.nSE[i] + this.nSW[i]);

                let ux = thisux / thisrho;
                let uy = thisuy / thisrho;
                
                // STABILITY CHECK 2: Limit velocity for stability
                const speed = Math.sqrt(ux*ux + uy*uy);
                if (speed > this.maxAllowedSpeed) {
                    // Scale back velocity to maximum allowed
                    const scale = this.maxAllowedSpeed / speed;
                    ux *= scale;
                    uy *= scale;
                    stabilityCorrections++;
                }
                
                // Update statistics
                maxSpeed = Math.max(maxSpeed, speed);
                minDensity = Math.min(minDensity, thisrho);

                // Store macroscopic values
                this.rho[i] = thisrho;
                this.ux[i]  = ux;
                this.uy[i]  = uy;

                // Adaptive relaxation based on local flow conditions
                // Use more stable relaxation in high-speed regions
                const localOmega = baseOmega * (1.0 - 0.5 * speed / this.maxAllowedSpeed);

                // Compute equilibrium values
                const one9thrho  = this.one9th  * thisrho;
                const one36thrho = this.one36th * thisrho;
                const ux3 = 3 * ux;
                const uy3 = 3 * uy;
                const ux2 = ux * ux;
                const uy2 = uy * uy;
                const uxuy2 = 2 * ux * uy;
                const u2 = ux2 + uy2;
                const u215 = 1.5 * u2;

                this.n0[i]  += localOmega * (this.four9ths * thisrho * (1 - u215) - this.n0[i]);
                this.nE[i]  += localOmega * (one9thrho * (1 + ux3 + 4.5*ux2 - u215) - this.nE[i]);
                this.nW[i]  += localOmega * (one9thrho * (1 - ux3 + 4.5*ux2 - u215) - this.nW[i]);
                this.nN[i]  += localOmega * (one9thrho * (1 + uy3 + 4.5*uy2 - u215) - this.nN[i]);
                this.nS[i]  += localOmega * (one9thrho * (1 - uy3 + 4.5*uy2 - u215) - this.nS[i]);
                this.nNE[i] += localOmega * (one36thrho * (1 + ux3 + uy3 + 4.5*(u2 + uxuy2) - u215) - this.nNE[i]);
                this.nSE[i] += localOmega * (one36thrho * (1 + ux3 - uy3 + 4.5*(u2 - uxuy2) - u215) - this.nSE[i]);
                this.nNW[i] += localOmega * (one36thrho * (1 - ux3 + uy3 + 4.5*(u2 - uxuy2) - u215) - this.nNW[i]);
                this.nSW[i] += localOmega * (one36thrho * (1 - ux3 - uy3 + 4.5*(u2 + uxuy2) - u215) - this.nSW[i]);
            }
        }
        
        // Update diagnostic variables
        this.maxSpeed = maxSpeed;
        this.minDensity = minDensity;
        this.stabilityCorrections += stabilityCorrections;
        
        // Calculate Reynolds number: Re = L * U / ν
        // Using chord length as characteristic length
        const characteristicLength = this.xdim / 6; // Based on chordFraction
        this.reynoldsNumber = characteristicLength * this.maxSpeed / this.viscosity;
    }

    // Stream function with interpolated bounce-back
    stream() {
        // Stream north-moving
        for (let y = this.ydim - 2; y > 0; y--) {
            for (let x = 1; x < this.xdim - 1; x++) {
                this.nN[x + y*this.xdim]  = this.nN[x + (y-1)*this.xdim];
                this.nNW[x + y*this.xdim] = this.nNW[x + 1 + (y-1)*this.xdim];
                this.nNE[x + y*this.xdim] = this.nNE[x - 1 + (y-1)*this.xdim];
            }
        }
        // Stream south-moving
        for (let y = 0; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                this.nS[x + y*this.xdim]  = this.nS[x + (y+1)*this.xdim];
                this.nSW[x + y*this.xdim] = this.nSW[x + 1 + (y+1)*this.xdim];
                this.nSE[x + y*this.xdim] = this.nSE[x - 1 + (y+1)*this.xdim];
            }
        }
        
        // Interpolated bounce-back from barriers
        for (let y = 1; y < this.ydim - 1; y++) {
            for (let x = 1; x < this.xdim - 1; x++) {
                const i = x + y*this.xdim;
                
                if (this.barriers[i]) {
                    // Standard bounce-back for solid nodes
                    [this.nE[x+1 + y*this.xdim], this.nW[i]] = [this.nW[i], this.nE[i]];
                    [this.nN[x + (y+1)*this.xdim], this.nS[i]] = [this.nS[i], this.nN[i]];
                    [this.nNE[x+1 + (y+1)*this.xdim], this.nSW[i]] = [this.nSW[i], this.nNE[i]];
                    [this.nNW[x-1 + (y+1)*this.xdim], this.nSE[i]] = [this.nSE[i], this.nNW[i]];
                } else {
                    // For fluid cells near barriers, use interpolated bounce-back
                    // This results in smoother boundaries and more accurate flow
                    const d = this.distanceField[i];
                    
                    // Only apply to cells near boundaries
                    if (d < 1.0) {
                        // E neighbor check
                        if (x < this.xdim - 1 && this.barriers[i + 1]) {
                            // Interpolated bounce-back for better accuracy
                            // This adjusts for the actual boundary position
                            const q = 1.0 - d;  // Interpolation coefficient
                            this.nW[i] = q * this.nE[i] + (1-q) * this.nW[i];
                        }
                        
                        // W neighbor check
                        if (x > 0 && this.barriers[i - 1]) {
                            const q = 1.0 - d;
                            this.nE[i] = q * this.nW[i] + (1-q) * this.nE[i];
                        }
                        
                        // N neighbor check
                        if (y < this.ydim - 1 && this.barriers[i + this.xdim]) {
                            const q = 1.0 - d;
                            this.nS[i] = q * this.nN[i] + (1-q) * this.nS[i];
                        }
                        
                        // S neighbor check
                        if (y > 0 && this.barriers[i - this.xdim]) {
                            const q = 1.0 - d;
                            this.nN[i] = q * this.nS[i] + (1-q) * this.nN[i];
                        }
                        
                        // Diagonal directions - only apply if direct neighbors are fluid
                        // NE neighbor
                        if (x < this.xdim - 1 && y < this.ydim - 1 && 
                            this.barriers[i + 1 + this.xdim] && 
                            !this.barriers[i + 1] && !this.barriers[i + this.xdim]) {
                            const q = 1.0 - d;
                            this.nSW[i] = q * this.nNE[i] + (1-q) * this.nSW[i];
                        }
                        
                        // NW neighbor
                        if (x > 0 && y < this.ydim - 1 && 
                            this.barriers[i - 1 + this.xdim] && 
                            !this.barriers[i - 1] && !this.barriers[i + this.xdim]) {
                            const q = 1.0 - d;
                            this.nSE[i] = q * this.nNW[i] + (1-q) * this.nSE[i];
                        }
                        
                        // SE neighbor
                        if (x < this.xdim - 1 && y > 0 && 
                            this.barriers[i + 1 - this.xdim] && 
                            !this.barriers[i + 1] && !this.barriers[i - this.xdim]) {
                            const q = 1.0 - d;
                            this.nNW[i] = q * this.nSE[i] + (1-q) * this.nNW[i];
                        }
                        
                        // SW neighbor
                        if (x > 0 && y > 0 && 
                            this.barriers[i - 1 - this.xdim] && 
                            !this.barriers[i - 1] && !this.barriers[i - this.xdim]) {
                            const q = 1.0 - d;
                            this.nNE[i] = q * this.nSW[i] + (1-q) * this.nNE[i];
                        }
                    }
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

    // Draw function
    draw() {
        this.computeSpeed();
    
        // Calculate the dynamic range of the velocity field
        let maxObservedSpeed = 0.001; // Avoid division by zero
        let sumSpeed = 0;
        let count = 0;
        
        for (let i = 0; i < this.speed.length; i++) {
            if (!this.barriers[i]) {
                maxObservedSpeed = Math.max(maxObservedSpeed, this.speed[i]);
                sumSpeed += this.speed[i];
                count++;
            }
        }
        
        // Calculate average speed
        const avgSpeed = sumSpeed / Math.max(1, count);
        
        // Use a combination of maximum and average speed for better scaling        
        const effectiveMaxSpeed = Math.max(this.flowSpeed * 1.3, maxObservedSpeed * 0.85);
        const scale = this.nColors / effectiveMaxSpeed;
        
        for (let y = 0; y < this.ydim; y++) {
            for (let x = 0; x < this.xdim; x++) {
                const i = x + y * this.xdim;
                
                if (this.barriers[i]) {
                    // barrier in white
                    this.fillSquare(x, y, 255, 255, 255);
                    continue;
                }
    
                const spd = this.speed[i];
                
                // Apply non-linear mapping to better distribute colors                
                const normalizedSpeed = spd / effectiveMaxSpeed;
                const enhancedSpeed = Math.pow(normalizedSpeed, 0.85);
                
                let colorIndex = Math.floor(enhancedSpeed * this.nColors);
                colorIndex = Math.max(0, Math.min(this.nColors - 1, colorIndex));
    
                const c = this.colors[colorIndex];
                this.fillSquare(x, y, c.r, c.g, c.b);
            }
        }
        
        // Put the simulation pixels onto the canvas
        this.ctx.putImageData(this.imageData, 0, 0);
        
        // Add diagnostic information to status message
        this._updateDiagnostics();
    }
    
    // Update diagnostic information
    _updateDiagnostics() {
        const statusMsg = document.getElementById('statusMessage');
        if (statusMsg) {
            if (this.running) {
                statusMsg.innerHTML = `Status: Solving LBM<br>` +
                                     `Max Speed: ${this.maxSpeed.toFixed(4)}<br>` +
                                     `Re: ${Math.round(this.reynoldsNumber)}<br>` + 
                                     `Corrections: ${this.stabilityCorrections}`;
            } else {
                statusMsg.innerHTML = `Status: Paused<br>` +
                                     `Max Speed: ${this.maxSpeed.toFixed(4)}<br>` +
                                     `Re: ${Math.round(this.reynoldsNumber)}`;
            }
        }
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

    // Update method with error handling and FPS limiting
    update() {
        if (!this.running) return;
    
        try {
            // Limit steps per frame based on current stability
            const stepsPerFrame = this.stabilityCorrections > 0 ? 1 : 5;
            
            for (let step = 0; step < stepsPerFrame; step++) {
                this.setBoundaryConditions();
                this.collide();
                this.stream();
            }
    
            this.draw();
            
            // Use setTimeout instead of requestAnimationFrame for better stability
            // when performance is an issue
            if (this.stabilityCorrections > 50) {
                // If we're having lots of stability issues, slow down simulation
                setTimeout(() => this.update(), 50);
            } else {
                requestAnimationFrame(() => this.update());
            }
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
            thickness: this.airfoilThickness,
            angle: this.currentAngle,
            camber: this.airfoilCamber,
            camberPos: 0.4
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
    controlsDiv.className = 'simulation-controls'; // Add this line
    controlsDiv.style.position = 'absolute';
    controlsDiv.style.bottom = '20px';
    controlsDiv.style.right = '20px';
    controlsDiv.style.backgroundColor = 'rgba(24, 27, 29, 0.5)';
    controlsDiv.style.padding = '10px';
    controlsDiv.style.borderRadius = '5px';
    controlsDiv.style.zIndex = '1000'; 
    controlsDiv.style.cursor = 'default';
    controlsDiv.style.width = '200px';
    controlsDiv.innerHTML = `
        <div style="text-align: center; margin-bottom: 10px;">
            <button id="playPauseButton" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white; margin-bottom: 0px; font-family: monospace;">
                Simulate
            </button>
        </div>
        <div style="display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%;">
            <button id="increaseAngle" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">↓</button>
            <div id="angleDisplay" style="font-family: monospace; min-width: 80px; text-align: center;"></div>
            <button id="decreaseAngle" style="padding: 8px 15px; cursor: pointer; border: 1px solid #ccc; border-radius: 4px; background: white;">↑</button>
            </div>
        <div id="statusMessage" style="text-align: left; margin-top: 10px; font-family: monospace;"></div>
    `;
    
    container.appendChild(canvas);
    container.appendChild(controlsDiv);

    const rect = container.getBoundingClientRect();
    canvas.width = Math.max(Math.floor(rect.width), 600);
    canvas.height = Math.max(Math.floor(rect.height), 400);

    // Create simulation with higher flow speed
    const simulation = new FluidSimulation(canvas, {
        pxPerSquare: 2,
        flowSpeed: 0.35, // Increased from 0.225
        flowAngleDeg: 0,
        viscosity: 0.25 // Slightly reduced from 0.3
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
    
    document.getElementById('statusMessage').textContent = 'Status: Domain Initialized';

    observer.observe(canvas);

    // Set up angle control handlers
    const stepSize = 0.0872665; // 5 degrees
    const angleDisplay = document.getElementById('angleDisplay');
    const updateAngleDisplay = () => {
        const degrees = (simulation.currentAngle * 180 / Math.PI).toFixed(1);
        const radians = simulation.currentAngle.toFixed(2);
        //angleDisplay.innerHTML = `${radians*-1} rad<br>${degrees*-1}°`;
        angleDisplay.innerHTML = `Adjust AoA<br>${degrees*-1}°`;
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