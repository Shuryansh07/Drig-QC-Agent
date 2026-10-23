# Deploying the WireSheet scraper to ECS Fargate

The image is already built and pushed:
`319797800920.dkr.ecr.us-east-1.amazonaws.com/wiresheet-scraper:latest`

The steps below need **IAM write + ECS register permissions** (the day-to-day
`satnam` key does not have `iam:CreateRole`). Run them with an admin profile.

Region `us-east-1`, account `319797800920`, cluster `Drig-qc-agent`.

## 1. Create the task role (once)

Gives the task exactly what it needs: read the DB password secret, and
read/write the `qc-wiresheet` bucket. Nothing else.

```bash
aws iam create-role \
  --role-name ecs-wiresheet-task-role \
  --assume-role-policy-document file://task-role-trust.json

aws iam put-role-policy \
  --role-name ecs-wiresheet-task-role \
  --policy-name wiresheet-scraper-policy \
  --policy-document file://task-role-policy.json
```

The **execution role** is the existing `ecsTaskExecutionRole` (already pulls from
ECR and writes CloudWatch logs for the backend) — no change needed.

> If the DB secret is encrypted with a customer-managed KMS key (not the default
> `aws/secretsmanager`), also grant `kms:Decrypt` on that key in the policy.

## 2. Set the Wiresheet password, then register the task definition

`ecs-task-definition.json` has `WIRESHEET_PASSWORD` as a placeholder on purpose —
do not commit the real password. Either replace it just before registering, or
(better) move it to Secrets Manager and use the task def `secrets` field.

```bash
# replace the placeholder with the real dealer password, then:
aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json
```

## 3. Phase 1 — backfill (run it until the full index is scraped)

Run it as a standalone task. It resumes from the database, so if it stops you
just run it again. Use your VPC's private subnet(s) + a security group allowing
outbound 443 (Wiresheet, S3, Secrets Manager) and 5432 (RDS).

```bash
aws ecs run-task \
  --cluster Drig-qc-agent \
  --launch-type FARGATE \
  --task-definition qc-wiresheet-scraper \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-xxxx],securityGroups=[sg-xxxx],assignPublicIp=DISABLED}'
```

Watch it in CloudWatch: log group `/ecs/qc-wiresheet-scraper`.

`assignPublicIp=DISABLED` + a private subnet behind NAT gives a stable egress IP
(what the scrape plan wants). If the subnet has no NAT, use a public subnet with
`assignPublicIp=ENABLED` for a first test — but the IP then changes per run.

## 4. Phase 2 — weekly check (after backfill is caught up)

An EventBridge Scheduler schedule that runs the same task once a week. Needs a
small role that lets EventBridge call `ecs:RunTask` + `iam:PassRole` on the two
roles above (see the scheduler docs). Not created here yet.

> Known gap: the weekly run finds NEW vehicles, but does not yet re-check
> vehicles that had no wiring last time and have since been filled in. That is a
> small code change (stop permanently marking empty results "done") to make
> before relying on the weekly cadence for "missing wiresheet got uploaded".

## Notes

- The URL user is `drigadmin` to match the RDS master secret in `DB_SECRET_ARN`.
  For least privilege, create a `drig_app` secret and switch both the URL user
  and `DB_SECRET_ARN` to it.
- Default command is `--delay 8000` (8s between requests) — polite pacing. Adjust
  in the task def `command`, or override per run with `--overrides`.
