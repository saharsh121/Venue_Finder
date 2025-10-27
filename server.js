const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const mysql = require('mysql2');
const cron = require("node-cron");

const app = express();
const PORT = 8080;

// ✅ MySQL CONNECTION
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Saharsh@121', // change if needed
  database: 'vit_venue',
  port: 3306
});

db.connect(err => {
  if (err) throw err;
  console.log("✅ Connected to MySQL database.");
});

// ✅ CRON JOB: Update event status & venue occupancy every minute
cron.schedule("* * * * *", () => {
    const now = new Date();

    // 1️⃣ Update event statuses
    db.query(
        "UPDATE events SET status='active' WHERE start_time <= ? AND end_time >= ? AND status='upcoming'",
        [now, now],
        (err) => { if (err) console.error("Error activating events:", err); }
    );
    db.query(
        "UPDATE events SET status='completed' WHERE end_time < ? AND status IN ('upcoming','active')",
        [now],
        (err) => { if (err) console.error("Error completing events:", err); }
    );

    // 2️⃣ Update venue availability based on active events
    db.query("SELECT * FROM events WHERE status='active'", (err, activeEvents) => {
        if (err) return console.error("Error fetching active events:", err);

        // First, mark affected venues as vacant if they are not in active events
        // Fetch all rooms/buildings/floors/day
        db.query("SELECT * FROM venue_availability", (err, allVenues) => {
            if (err) return console.error("Error fetching venues:", err);

            allVenues.forEach(venue => {
                let isOccupied = activeEvents.some(event => {
                    if(event.booking_type === "building") return event.building === venue.building;
                    if(event.booking_type === "floor") return event.building === venue.building && event.floor === venue.floor;
                    if(event.booking_type === "room") return event.room_id === venue.room_id;
                    if(event.booking_type === "day") return new Date(event.start_time).getDay()+1 === venue.day; // JS getDay(): 0=Sun, MySQL DAYOFWEEK: 1=Sun
                    return false;
                });

                const newStatus = isOccupied ? 'occupied' : 'vacant';
                if(venue.status !== newStatus) {
                    db.query("UPDATE venue_availability SET status=? WHERE id=?", [newStatus, venue.id]);
                }
            });
        });
    });
});

// ✅ MIDDLEWARE
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ✅ ROUTES FOR PAGES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'views', 'student.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
app.get('/results', (req, res) => res.sendFile(path.join(__dirname, 'views', 'results.html')));
app.get('/student-home', (req, res) => res.sendFile(path.join(__dirname, 'views', 'student-home.html')));
app.get('/admin-home', (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin-home.html')));

// ✅ LOGIN ROUTES
app.post('/student-login', (req, res) => {
  const { username, password } = req.body;
  const query = "SELECT * FROM students WHERE username=? AND password=?";
  db.query(query, [username, password], (err, result) => {
    if (err) throw err;
    if (result.length === 1) res.redirect('/student-home');
    else res.send("<h2>Invalid credentials. <a href='/student'>Try again</a></h2>");
  });
});

app.post('/admin-login', (req, res) => {
  const { username, password } = req.body;
  const query = "SELECT * FROM admins WHERE username=? AND password=?";
  db.query(query, [username, password], (err, result) => {
    if (err) throw err;
    if (result.length === 1) res.redirect('/admin-home');
    else res.send("<h2>Invalid admin credentials. <a href='/admin'>Try again</a></h2>");
  });
});

// ✅ STUDENT CHECK AVAILABILITY
app.get('/check-availability', (req, res) => {
  const { day, building, floor, time_slot } = req.query;

  if (!day) return res.status(400).json({ error: 'Day is required' });

  let query = "SELECT * FROM venue_availability WHERE status='vacant' AND day=?";
  const params = [day];

  if (building) { query += " AND building=?"; params.push(building); }
  if (floor) { query += " AND floor=?"; params.push(floor); }
  if (time_slot) { query += " AND time_slot=?"; params.push(time_slot); }

  db.query(query, params, (err, results) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({
      filters: { day, building: building || null, floor: floor || null, time_slot: time_slot || null },
      rooms: results
    });
  });
});

// ✅ FEEDBACK ROUTES
app.post('/submit-feedback', (req,res)=>{
  const { name,email,message } = req.body;
  const sql = "INSERT INTO feedback (name,email,message) VALUES (?,?,?)";
  db.query(sql,[name,email,message],(err)=>{
    if(err) return res.status(500).send('Database insert failed.');
    res.send('Thank you for your feedback!');
  });
});

app.get('/get-feedback',(req,res)=>{
  const sql = "SELECT * FROM feedback ORDER BY submitted_at DESC";
  db.query(sql,(err,results)=>{
    if(err) return res.status(500).json({ error:'Failed to fetch feedback' });
    res.json(results);
  });
});

// ✅ EVENT BOOKING
app.post('/book-event', (req,res)=>{
  const { event_name, booking_type, building, floor, room_id, start_time, end_time } = req.body;

  // Check overlapping bookings
  let overlapQuery = "SELECT * FROM events WHERE ((start_time BETWEEN ? AND ?) OR (end_time BETWEEN ? AND ?))";
  const params = [start_time, end_time, start_time, end_time];

  db.query(overlapQuery, params, (err, overlappingEvents)=>{
    if(err) return res.status(500).json({ success:false, error:'DB error' });
    if(overlappingEvents.length>0) return res.json({ success:false, error:'Time conflict with another event.' });

    const sql = `
      INSERT INTO events (event_name, booking_type, building, floor, room_id, start_time, end_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'upcoming')
    `;
    db.query(sql,[event_name,booking_type,building,floor||null,room_id||null,start_time,end_time], (err)=>{
      if(err) return res.status(500).json({ success:false, error:'DB error' });
      res.json({ success:true, message:'Event booked successfully!' });
    });
  });
});

// ✅ FILTER EVENTS
// ✅ FILTER EVENTS (Final Fix)
app.get('/admin-events', (req, res) => {
  const { status, booking_type } = req.query;

  // Base query (only booking_type is filterable in SQL)
  let query = "SELECT * FROM events WHERE 1=1";
  const params = [];

  if (booking_type) {
    query += " AND booking_type=?";
    params.push(booking_type);
  }

  query += " ORDER BY start_time ASC";

  db.query(query, params, (err, results) => {
    if (err) {
      console.error("DB Error:", err);
      return res.status(500).json({ success: false, events: [] });
    }

    const now = new Date();

    // Recalculate status dynamically
    results.forEach(event => {
      const start = new Date(event.start_time);
      const end = new Date(event.end_time);

      if (now < start) {
        event.status = 'upcoming';
      } else if (now >= start && now <= end) {
        event.status = 'active';
      } else {
        event.status = 'completed';
      }
    });

    // ✅ Apply status filter AFTER recalculation
    let filtered = results;
    if (status) {
      filtered = filtered.filter(ev => ev.status === status);
    }

    res.json({ success: true, events: filtered });
  });
});


// ✅ START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});


