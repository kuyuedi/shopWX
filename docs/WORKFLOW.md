# Development Workflow

## Overview

Simple workflow for collaboration between **Product Owner** and **Developer** using a features folder.

```
PRODUCT OWNER                           DEVELOPER
─────────────                           ─────────

1. Create feature spec
   in features/ folder
        │
        ▼
2. Notify developer            ───────► 3. Review spec
                                              │
                                              ▼
4. Answer questions            ◄─────── Ask clarifications
        │                                     │
        ▼                                     ▼
5. Approve approach            ◄─────── Create plan
                                              │
                                              ▼
                                        6. Implement with
                                           Claude Code
                                              │
                                              ▼
7. Verify results              ◄─────── 7. Deploy & verify
```

---

## For Product Owner

### Creating a Feature Request

1. **Copy the template**
   ```
   features/_TEMPLATE.md → features/your-feature-name.md
   ```

2. **Fill in all sections** (see template for guidance)
   - Summary (one sentence)
   - Problem (why we need this)
   - Algorithm/Logic (step-by-step)
   - Configuration parameters
   - Edge cases
   - Verification SQL

3. **Set status and priority**
   ```markdown
   **Status**: NEW
   **Priority**: High
   ```

4. **Notify the developer**

### Tips for Good Specs

| Do | Don't |
|----|-------|
| Include exact formulas | Say "calculate the price" |
| Give input/output examples | Assume developer knows the domain |
| Define edge cases | Leave ambiguity |
| Provide verification SQL | Skip testing criteria |

---

## For Developer

### Implementing a Feature

1. **Read the spec** in `features/` folder

2. **Ask questions** if anything is unclear

3. **Update status** to IN PROGRESS
   ```markdown
   **Status**: IN PROGRESS
   ```

4. **Implement with Claude Code**
   ```
   > claude
   You: Implement the feature in features/best-price-calculation.md
   ```

5. **Deploy**
   ```bash
   git add . && git commit -m "feat: implement best price calculation"
   git push origin main
   ./deploy.sh
   ```

6. **Verify** using the SQL in the spec

7. **Update status** to COMPLETED
   ```markdown
   **Status**: COMPLETED
   ```

---

## File Structure

```
features/
├── README.md                        # Instructions
├── _TEMPLATE.md                     # Copy this for new features
├── best-price-band-liquidity.md     # Example feature
└── [your-feature].md                # Your new features
```

---

## Status Values

| Status | Meaning |
|--------|---------|
| `NEW` | Just created, awaiting review |
| `IN PROGRESS` | Being implemented |
| `COMPLETED` | Done and deployed |
| `ON HOLD` | Needs clarification |

---

## Quick Reference

### Product Owner
1. Copy `features/_TEMPLATE.md`
2. Fill in all sections
3. Save with descriptive name
4. Notify developer

### Developer
1. Read spec in `features/`
2. Ask questions
3. Implement with Claude Code
4. Deploy with `./deploy.sh`
5. Verify with provided SQL
6. Update status to COMPLETED
