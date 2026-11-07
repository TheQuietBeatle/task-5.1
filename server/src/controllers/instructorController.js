import bcrypt from 'bcryptjs';
import Joi from 'joi';
import { Instructor } from '../models/Instructor.js';

// bcrypt hash of a random throwaway value, used to equalise timing for unknown
// usernames so a 401 never reveals whether the account exists.
const DUMMY_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// =============================================================================
//  INSTRUCTOR PORTAL CONTROLLER
// =============================================================================
//
// NoSQL injection defence, in three layers:
//   1. express-mongo-sanitize (app.js) strips $/.-prefixed keys from input.
//   2. Joi schemas below reject anything that is not the expected shape — an
//      object where a string belongs is rejected, not coerced.
//   3. Queries only ever receive validated strings, never req.body/req.query,
//      and responses use explicit projections that exclude secrets.
//
// Joi vs express-mongo-sanitize:
//   - Joi validates *shape, type and value* of data your app knows about.
//   - express-mongo-sanitize is a broad safety net that neutralises MongoDB
//     operators ($ne, $where, ...) and dot-paths anywhere in req.body/query/
//     params. Sanitizing alone can silently drop input; validation alone can
//     miss new fields added later. Use both.

const loginSchema = Joi.object({
  username: Joi.string().trim().min(1).max(60).required(),
  password: Joi.string().min(1).max(200).required()
});

const searchSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  department: Joi.string().trim().min(1).max(100),
  role: Joi.string().valid('instructor', 'superadmin')
});

// Fields a directory/search viewer is allowed to see. Never password, apiKey,
// privateEmail or privatePhone.
const PUBLIC_FIELDS = 'name username department role';

// What the signed-in instructor themselves may see on their own dashboard.
// Still no password.
function sessionProfile(doc) {
  const profile = {
    id: doc._id.toString(),
    name: doc.name,
    username: doc.username,
    department: doc.department,
    role: doc.role
  };
  if (doc.role === 'superadmin' && doc.apiKey) profile.apiKey = doc.apiKey;
  return profile;
}

// POST /api/instructors/login
export async function loginInstructor(req, res, next) {
  try {
    const { value, error } = loginSchema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ message: error.message });

    const instructor = await Instructor.findOne({ username: value.username })
      .select('+password +apiKey');

    // Compare against a dummy hash when the user is unknown so both paths cost
    // the same (no username-enumeration timing oracle).
    if (!instructor) {
      await bcrypt.compare(value.password, DUMMY_HASH);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const ok = await instructor.comparePassword(value.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

    return res.json({ instructor: sessionProfile(instructor) });
  } catch (err) {
    next(err);
  }
}

// GET /api/instructors
// Public directory: limited fields only.
export async function getDirectory(req, res, next) {
  try {
    const instructors = await Instructor.find()
      .select(PUBLIC_FIELDS)
      .sort({ name: 1 })
      .lean();
    res.json({ instructors });
  } catch (err) {
    next(err);
  }
}

// GET /api/instructors/search?name=Smith[&department=Math][&role=instructor]
// Only the documented keys are read; everything else is ignored. Values are
// always strings, so operators cannot reach the query.
export async function searchInstructors(req, res, next) {
  try {
    const { value, error } = searchSchema.validate(req.query, { abortEarly: false });
    if (error) return res.status(400).json({ message: error.message });

    const filter = { name: new RegExp(escapeRegex(value.name), 'i') };
    if (value.department) filter.department = value.department;
    if (value.role) filter.role = value.role;

    const instructors = await Instructor.find(filter)
      .select(PUBLIC_FIELDS)
      .sort({ name: 1 })
      .lean();
    res.json({ count: instructors.length, instructors });
  } catch (err) {
    next(err);
  }
}

function escapeRegex(input) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
