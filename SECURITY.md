# Security & Key Management

## Key storage

Currently all secrets are stored in `Pulumi.<stack>.yaml` files in encrypted form.
Encryption key controled by admin (local backend) or Pulumi Cloud (remote cloud backend).

In production better access control is needed as more people and agents need access to the secrets.

For self-hosted scenario HashiCorp Vault is a good option and integrates well with Pulumi.

Other cloud backends, like AWS SecretsManager are also supported and can be considered if the provider is already used.

## Key rotation

Updating any keys is mostly a matter of generating a new one and updating deployment to use it:

```sh
pulumi config set midnight:encryptionKey --secret <value>
pulumi up
```

In case of keys used by multiple nodes, a 2-step deploy might be needed where a new key is used but old one still exists while other nodes update their reference.

## Incident response

- revoke key and remove node from validator set and access to any related services
- deep dive into what happened and the scope of the compromise
- generate new key and bring the node back after rebuilding it
